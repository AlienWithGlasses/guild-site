// Guild Hall: static front end talking to Supabase.
// All text from users is inserted with textContent, never innerHTML,
// so nobody can inject scripts through a message or guide.

const cfg = window.GUILD_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const state = {
  user: null,        // auth user
  me: null,          // profile row {id, username, is_owner}
  owner: null,       // owner's profile
  profiles: new Map(),
  privatePeer: null, // profile id of the other person in private chat
  channel: null,
  comments: [],      // guide_comments rows for the guides on screen
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v; // only ever called with DOMPurify-sanitized output
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};

// ---------- helpers ----------

function notify(msg, ok = false) {
  const n = $("#notice");
  n.textContent = msg;
  n.className = "notice" + (ok ? " ok" : "");
  n.hidden = false;
  clearTimeout(notify.t);
  notify.t = setTimeout(() => (n.hidden = true), 6000);
}

const nameToEmail = (name) => `${name.trim().toLowerCase()}@${cfg.LOGIN_EMAIL_DOMAIN}`;
const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function youtubeId(input) {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12);
    if (host.endsWith("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/\/(embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch { /* not a URL */ }
  return null;
}

async function withBusy(form, fn) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

// ---------- auth ----------

function showAuthTab(which) {
  $("#tab-login").classList.toggle("active", which === "login");
  $("#tab-signup").classList.toggle("active", which === "signup");
  $("#form-login").hidden = which !== "login";
  $("#form-signup").hidden = which !== "signup";
}
$("#tab-login").onclick = () => showAuthTab("login");
$("#tab-signup").onclick = () => showAuthTab("signup");

$("#form-login").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const { error } = await sb.auth.signInWithPassword({
      email: nameToEmail(f.username.value),
      password: f.password.value,
    });
    if (error) return notify("Wrong name or password.");
    f.reset();
  });
};

$("#form-signup").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const code = f.code.value.trim().toUpperCase();
    const username = f.username.value.trim();
    if (f.password.value !== f.password2.value) return notify("The two passwords are not the same.");

    const { data: codeOk } = await sb.rpc("check_invite_code", { p_code: code });
    if (!codeOk) return notify("That activation code is not valid or was already used.");
    const { data: nameOk } = await sb.rpc("username_available", { p_name: username });
    if (!nameOk) return notify("That name is taken. Try another one.");

    const { error } = await sb.auth.signUp({
      email: nameToEmail(username),
      password: f.password.value,
      options: { data: { invite_code: code, username } },
    });
    if (error) return notify("Could not create the account: " + error.message);
    f.reset();
    notify("Welcome to the guild!", true);
  });
};

$("#logout").onclick = () => sb.auth.signOut();

sb.auth.onAuthStateChange((_event, session) => {
  // Defer so we never call Supabase inside the auth callback itself.
  setTimeout(() => onSession(session), 0);
});

async function onSession(session) {
  const uid = session?.user?.id ?? null;
  if (uid === state.user?.id) return;
  state.user = session?.user ?? null;
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }

  if (!state.user) {
    state.me = null;
    $("#nav").hidden = $("#who").hidden = true;
    showView("auth");
    return;
  }
  await loadProfiles();
  state.me = state.profiles.get(state.user.id);
  if (!state.me) { notify("Your profile was not found."); return sb.auth.signOut(); }

  $("#who-name").textContent = state.me.username + (state.me.is_owner ? " (owner)" : "");
  $("#nav").hidden = $("#who").hidden = false;
  $("#nav-owner").hidden = $("#nav-members").hidden = !state.me.is_owner;
  document.querySelectorAll(".owner-only").forEach((n) => (n.hidden = !state.me.is_owner));
  $(".private-layout").classList.toggle("with-list", state.me.is_owner);
  $("#private-hint").textContent = state.me.is_owner
    ? "Pick a member on the left. Only you and that member can read the conversation."
    : "Only you and the guild owner can read these.";

  subscribeMessages();
  showView(location.hash.slice(1) || "guides");
}

async function loadProfiles() {
  const { data, error } = await sb.from("profiles").select("id, username, is_owner").order("username");
  if (error) return notify("Could not load members: " + error.message);
  state.profiles = new Map(data.map((p) => [p.id, p]));
  state.owner = data.find((p) => p.is_owner) ?? null;
}

// ---------- navigation ----------

const VIEWS = ["auth", "guides", "videos", "public", "private", "members", "owner"];
function showView(name) {
  if (!state.me && name !== "auth") name = "auth";
  if ((name === "owner" || name === "members") && !state.me?.is_owner) name = "guides";
  if (!VIEWS.includes(name)) name = "guides";
  for (const v of VIEWS) $("#view-" + v).hidden = v !== name;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name !== "auth") history.replaceState(null, "", "#" + name);
  ({ guides: loadGuides, videos: loadVideos, public: loadPublic, private: openPrivate, members: loadMembers, owner: loadCodes }[name] || (() => {}))();
}
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

// ---------- guides ----------

// Guides are written in Markdown and shown as HTML. Everything passes through DOMPurify,
// so no script, event handler or odd URL from a guide can run in a member's browser.
marked.setOptions({ breaks: true, gfm: true });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer nofollow"); }
  if (node.tagName === "IMG") { node.setAttribute("loading", "lazy"); node.setAttribute("referrerpolicy", "no-referrer"); }
});
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text ?? ""), {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe"],
    FORBID_ATTR: ["style"],
  });
}

async function loadGuides() {
  const list = $("#guides-list");
  const { data, error } = await sb.from("guides").select("*").order("created_at", { ascending: false });
  if (error) return notify(error.message);
  const { data: comments, error: cErr } = await sb.from("guide_comments").select("*").order("created_at");
  if (cErr) notify("Comments could not load: " + cErr.message);
  state.comments = comments ?? [];
  list.replaceChildren();
  if (!data.length) list.append(el("p", { class: "empty", text: "No guides yet." }));
  for (const g of data) {
    const actions = state.me.is_owner
      ? el("div", { class: "row" },
          el("button", { class: "link", text: "Edit", onclick: () => editGuide(g) }),
          el("button", { class: "link danger", text: "Delete", onclick: () => deleteRow("guides", g.id, loadGuides) }))
      : null;
    list.append(el("article", { class: "card guide" },
      el("h2", { text: g.title }),
      el("div", { class: "meta", text: "Updated " + fmtTime(g.updated_at) }),
      el("div", { class: "body md", html: renderMarkdown(g.body) }),
      actions,
      el("section", { class: "discussion", "data-guide": g.id })));
    renderDiscussion(g.id);
  }
}

// ---------- guide comments ----------

function renderDiscussion(guideId) {
  const box = document.querySelector(`.discussion[data-guide="${guideId}"]`);
  if (!box) return;
  const all = (state.comments ?? []).filter((c) => c.guide_id === guideId);
  const tops = all.filter((c) => c.parent_id == null);
  const open = box.querySelector("details")?.open ?? false;
  const details = el("details", { class: "thread" });
  details.open = open || location.hash === "#guide-" + guideId;
  details.append(el("summary", { text: all.length ? `Discussion (${all.length})` : "Discussion" }));
  const list = el("div", { class: "comments" });
  if (!tops.length) list.append(el("p", { class: "empty", text: "No comments yet. Start the conversation." }));
  for (const c of tops) {
    const replies = all.filter((r) => r.parent_id === c.id);
    list.append(el("div", { class: "thread-item" },
      renderComment(c, guideId, true),
      ...replies.map((r) => el("div", { class: "reply" }, renderComment(r, guideId, false)))));
  }
  details.append(list, commentForm(guideId, null, "Write a comment…", "Post comment"));
  box.replaceChildren(details);
}

function renderComment(c, guideId, canReply) {
  const author = state.profiles.get(c.author_id);
  const mine = c.author_id === state.me.id;
  const node = el("div", { class: "comment" + (author?.is_owner ? " owner" : ""), "data-id": c.id },
    el("div", { class: "head" },
      el("b", { text: author?.username ?? "former member" }),
      author?.is_owner ? el("span", { class: "badge", text: "Owner" }) : null,
      el("span", { text: fmtTime(c.created_at) }),
      canReply ? el("button", { class: "link", text: "Reply", onclick: (e) => toggleReply(node, guideId, c.id, e.target) }) : null,
      (mine || state.me.is_owner) ? el("button", { class: "link danger del", text: "delete", onclick: () => deleteComment(c.id, guideId) }) : null),
    el("div", { class: "text", text: c.body }));
  return node;
}

function toggleReply(node, guideId, parentId, btn) {
  const existing = node.querySelector("form");
  if (existing) { existing.remove(); btn.textContent = "Reply"; return; }
  const f = commentForm(guideId, parentId, "Write a reply…", "Post reply");
  node.append(f);
  btn.textContent = "Cancel";
  f.querySelector("textarea").focus();
}

function commentForm(guideId, parentId, placeholder, label) {
  const ta = el("textarea", { rows: "2", maxlength: "2000", required: "", placeholder, "aria-label": placeholder });
  const f = el("form", { class: "composer comment-form" }, ta, el("button", { type: "submit", class: "primary", text: label }));
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = ta.value.trim();
    if (!body) return;
    withBusy(f, async () => {
      const { data, error } = await sb.from("guide_comments")
        .insert({ guide_id: guideId, parent_id: parentId, author_id: state.me.id, body }).select().single();
      if (error) return notify(error.message);
      addComment(data);
    });
  };
  return f;
}

function addComment(c) {
  if ((state.comments ??= []).some((x) => x.id === c.id)) return;
  state.comments.push(c);
  renderDiscussion(c.guide_id);
  const d = document.querySelector(`.discussion[data-guide="${c.guide_id}"] details`);
  if (d) d.open = true;
}

async function deleteComment(id, guideId) {
  const { error } = await sb.from("guide_comments").delete().eq("id", id);
  if (error) return notify(error.message);
  removeComment(id, guideId);
}

// Live updates from other members: re-render without forcing the thread open.
function addCommentQuietly(c) {
  if ((state.comments ??= []).some((x) => x.id === c.id)) return;
  state.comments.push(c);
  renderDiscussion(c.guide_id);
}

function removeComment(id, guideId) {
  const gone = new Set([id]);
  for (const c of state.comments ?? []) if (c.parent_id === id) gone.add(c.id); // replies go with their parent
  state.comments = (state.comments ?? []).filter((c) => !gone.has(c.id));
  if (guideId) renderDiscussion(guideId);
  else document.querySelectorAll(".discussion").forEach((n) => renderDiscussion(Number(n.dataset.guide)));
}

function editGuide(g) {
  const f = $("#form-guide");
  f.id.value = g.id; f.title.value = g.title; f.body.value = g.body; updatePreview();
  $("#guide-form-title").textContent = "Edit guide";
  $("#guide-cancel").hidden = false;
  f.scrollIntoView({ behavior: "smooth" });
}
function resetGuideForm() {
  const f = $("#form-guide");
  f.reset(); f.id.value = ""; updatePreview();
  $("#guide-form-title").textContent = "Write a guide";
  $("#guide-cancel").hidden = true;
}
$("#guide-cancel").onclick = resetGuideForm;

// live preview and .md file import in the guide editor
function updatePreview() {
  const v = $("#guide-body").value;
  $("#guide-preview-wrap").hidden = !v.trim();
  $("#guide-preview").innerHTML = renderMarkdown(v);
}
$("#guide-body").addEventListener("input", updatePreview);
$("#guide-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 200000) { e.target.value = ""; return notify("That file is too large. Guides can be up to 200 KB."); }
  const f = $("#form-guide");
  f.body.value = await file.text();
  if (!f.title.value.trim()) f.title.value = file.name.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ");
  e.target.value = "";
  updatePreview();
};

$("#form-guide").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const row = { title: f.title.value.trim(), body: f.body.value };
    const q = f.id.value
      ? sb.from("guides").update({ ...row, updated_at: new Date().toISOString() }).eq("id", f.id.value)
      : sb.from("guides").insert(row);
    const { error } = await q;
    if (error) return notify(error.message);
    resetGuideForm();
    loadGuides();
  });
};

async function deleteRow(table, id, reload) {
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) return notify(error.message);
  reload();
}

// ---------- videos ----------

async function loadVideos() {
  const list = $("#videos-list");
  const { data, error } = await sb.from("videos").select("*").order("created_at", { ascending: false });
  if (error) return notify(error.message);
  list.replaceChildren();
  if (!data.length) list.append(el("p", { class: "empty", text: "No videos yet." }));
  for (const v of data) {
    list.append(el("div", { class: "card video" },
      el("div", { class: "frame" },
        el("iframe", {
          src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.youtube_id)}`,
          title: v.title,
          loading: "lazy",
          allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
          allowfullscreen: "",
          referrerpolicy: "strict-origin-when-cross-origin",
        })),
      el("h2", { text: v.title }),
      state.me.is_owner
        ? el("button", { class: "link danger", text: "Remove", onclick: () => deleteRow("videos", v.id, loadVideos) })
        : null));
  }
}

$("#form-video").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const id = youtubeId(f.url.value);
    if (!id) return notify("That doesn't look like a YouTube link.");
    const { error } = await sb.from("videos").insert({ title: f.title.value.trim(), youtube_id: id });
    if (error) return notify(error.message);
    f.reset();
    loadVideos();
  });
};

// ---------- messages ----------

function renderMessage(m) {
  const author = state.profiles.get(m.author_id);
  const mine = m.author_id === state.me.id;
  const canDelete = mine || state.me.is_owner;
  return el("div", { class: "msg" + (mine ? " mine" : "") + (author?.is_owner ? " owner" : ""), "data-id": m.id },
    el("div", { class: "head" },
      el("b", { text: author?.username ?? "former member" }),
      author?.is_owner ? el("span", { class: "badge", text: "Owner" }) : null,
      el("span", { text: fmtTime(m.created_at) }),
      canDelete ? el("button", { class: "link danger del", text: "delete", onclick: () => deleteMessage(m.id) }) : null),
    el("div", { class: "text", text: m.body }));
}

function fillLog(log, rows, emptyText) {
  log.replaceChildren();
  if (!rows.length) log.append(el("p", { class: "empty", text: emptyText }));
  for (const m of rows) log.append(renderMessage(m));
  log.scrollTop = log.scrollHeight;
}

function appendToLog(log, m) {
  if (log.querySelector(`[data-id="${m.id}"]`)) return;
  log.querySelector(".empty")?.remove();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.append(renderMessage(m));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function loadPublic() {
  const { data, error } = await sb.from("messages").select("*")
    .is("recipient_id", null).order("created_at").limit(500);
  if (error) return notify(error.message);
  fillLog($("#public-log"), data, "No messages yet. Say hello!");
}

$("#form-public").onsubmit = (e) => sendMessage(e, null);
$("#form-private").onsubmit = (e) => {
  if (!state.privatePeer) { e.preventDefault(); return notify("Pick a member first."); }
  sendMessage(e, state.privatePeer);
};

function sendMessage(e, recipientId) {
  e.preventDefault();
  const f = e.target;
  const body = f.body.value.trim();
  if (!body) return;
  withBusy(f, async () => {
    const { data, error } = await sb.from("messages")
      .insert({ author_id: state.me.id, recipient_id: recipientId, body }).select().single();
    if (error) return notify(error.message);
    f.reset();
    appendToLog(recipientId ? $("#private-log") : $("#public-log"), data);
  });
}

async function deleteMessage(id) {
  const { error } = await sb.from("messages").delete().eq("id", id);
  if (error) return notify(error.message);
  document.querySelectorAll(`.msg[data-id="${id}"]`).forEach((n) => n.remove());
}

// Press Enter to send, Shift+Enter for a new line.
document.querySelectorAll(".composer textarea").forEach((t) =>
  t.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); t.form.requestSubmit(); }
  }));

async function openPrivate() {
  if (state.me.is_owner) {
    await loadProfiles();
    const list = $("#member-list");
    list.replaceChildren();
    const members = [...state.profiles.values()].filter((p) => !p.is_owner);
    if (!members.length) list.append(el("p", { class: "empty", text: "No members yet." }));
    for (const p of members) {
      list.append(el("button", {
        class: p.id === state.privatePeer ? "active" : "",
        text: p.username,
        onclick: () => { state.privatePeer = p.id; openPrivate(); },
      }));
    }
  } else {
    state.privatePeer = state.owner?.id ?? null;
  }

  const peer = state.profiles.get(state.privatePeer);
  $("#private-title").textContent = peer ? "Conversation with " + peer.username : "Pick a member";
  $("#form-private").hidden = !peer;
  if (!peer) return $("#private-log").replaceChildren();

  const a = state.me.id, b = peer.id;
  const { data, error } = await sb.from("messages").select("*")
    .or(`and(author_id.eq.${a},recipient_id.eq.${b}),and(author_id.eq.${b},recipient_id.eq.${a})`)
    .order("created_at").limit(500);
  if (error) return notify(error.message);
  fillLog($("#private-log"), data, "No messages yet.");
}

function subscribeMessages() {
  state.channel = sb.channel("messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, async ({ new: m }) => {
      if (!state.profiles.has(m.author_id)) await loadProfiles();
      if (m.recipient_id === null) {
        if (!$("#view-public").hidden) appendToLog($("#public-log"), m);
      } else {
        const other = m.author_id === state.me.id ? m.recipient_id : m.author_id;
        if (!$("#view-private").hidden && other === state.privatePeer) appendToLog($("#private-log"), m);
        else if (m.author_id !== state.me.id) notify(`New private message from ${state.profiles.get(m.author_id)?.username ?? "someone"}.`, true);
      }
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, ({ old }) => {
      document.querySelectorAll(`.msg[data-id="${old.id}"]`).forEach((n) => n.remove());
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "guide_comments" }, async ({ new: c }) => {
      if (!state.profiles.has(c.author_id)) await loadProfiles();
      addCommentQuietly(c);
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "guide_comments" }, ({ old }) => removeComment(old.id))
    .subscribe();
}

// ---------- owner: members ----------

async function loadMembers() {
  const { data, error } = await sb.rpc("list_members");
  if (error) return notify(error.message);
  const body = $("#members-body");
  body.replaceChildren();
  const others = data.filter((m) => m.id !== state.me.id);
  $("#members-empty").hidden = others.length > 0;
  for (const m of data) {
    const isMe = m.id === state.me.id;
    const actions = (m.is_owner || isMe) ? el("span", { class: "badge", text: isMe ? "You (owner)" : "Owner" })
      : el("div", { class: "row" },
          el("button", { class: "link", text: "New password", onclick: () => resetMemberPassword(m) }),
          el("button", { class: "link danger", text: "Remove", onclick: () => removeMember(m) }));
    body.append(el("tr", {},
      el("td", {}, el("b", { class: "member-name", text: m.username })),
      el("td", { text: fmtTime(m.created_at) }),
      el("td", { text: m.last_sign_in_at ? fmtTime(m.last_sign_in_at) : "Never" }),
      el("td", {}, actions)));
  }
}

async function removeMember(m) {
  if (!confirm(`Remove ${m.username}? Their login, messages and comments will be deleted. This cannot be undone.`)) return;
  const { error } = await sb.rpc("remove_member", { p_id: m.id });
  if (error) return notify(error.message);
  notify(`${m.username} was removed.`, true);
  await loadProfiles();
  loadMembers();
}

async function resetMemberPassword(m) {
  const pw = prompt(`New password for ${m.username} (at least 8 characters). They will be signed out everywhere and must log in with this one.`);
  if (pw === null) return;
  if (pw.length < 8) return notify("The password must have at least 8 characters.");
  const { error } = await sb.rpc("set_member_password", { p_id: m.id, p_password: pw });
  if (error) return notify(error.message);
  notify(`New password set for ${m.username}. Tell them in person; it is not stored anywhere.`, true);
}

// ---------- owner: activation codes ----------

async function loadCodes() {
  const { data, error } = await sb.from("invite_codes").select("*").order("created_at", { ascending: false });
  if (error) return notify(error.message);
  const body = $("#codes-body");
  body.replaceChildren();
  for (const c of data) {
    const usedBy = c.used_by ? state.profiles.get(c.used_by)?.username ?? "a member" : null;
    body.append(el("tr", {},
      el("td", {}, el("code", { text: c.code })),
      el("td", { text: usedBy ? `Used by ${usedBy}` : "Not used yet" }),
      el("td", {}, usedBy ? null : el("button", {
        class: "link danger", text: "Cancel code",
        onclick: async () => {
          const { error } = await sb.from("invite_codes").delete().eq("code", c.code);
          if (error) return notify(error.message);
          loadCodes();
        },
      }))));
  }
}

$("#new-code").onclick = async () => {
  const { data, error } = await sb.rpc("create_invite_code");
  if (error) return notify(error.message);
  notify(`New code: ${data}. Give it to one player.`, true);
  loadCodes();
};

// ---------- start ----------

$("#brand").textContent = cfg.GUILD_NAME || "Guild Hall";
document.title = cfg.GUILD_NAME || "Guild Hall";
if (cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
  showView("auth");
  notify("Setup needed: put your Supabase details in config.js (see README).");
} else {
  sb.auth.getSession().then(({ data }) => onSession(data.session));
}
