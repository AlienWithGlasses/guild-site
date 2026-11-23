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
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
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
  $("#nav-owner").hidden = !state.me.is_owner;
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

const VIEWS = ["auth", "guides", "videos", "public", "private", "owner"];
function showView(name) {
  if (!state.me && name !== "auth") name = "auth";
  if (name === "owner" && !state.me?.is_owner) name = "guides";
  if (!VIEWS.includes(name)) name = "guides";
  for (const v of VIEWS) $("#view-" + v).hidden = v !== name;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name !== "auth") history.replaceState(null, "", "#" + name);
  ({ guides: loadGuides, videos: loadVideos, public: loadPublic, private: openPrivate, owner: loadCodes }[name] || (() => {}))();
}
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

// ---------- guides ----------

async function loadGuides() {
  const list = $("#guides-list");
  const { data, error } = await sb.from("guides").select("*").order("created_at", { ascending: false });
  if (error) return notify(error.message);
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
      el("div", { class: "body", text: g.body }),
      actions));
  }
}

function editGuide(g) {
  const f = $("#form-guide");
  f.id.value = g.id; f.title.value = g.title; f.body.value = g.body;
  $("#guide-form-title").textContent = "Edit guide";
  $("#guide-cancel").hidden = false;
  f.scrollIntoView({ behavior: "smooth" });
}
function resetGuideForm() {
  const f = $("#form-guide");
  f.reset(); f.id.value = "";
  $("#guide-form-title").textContent = "Write a guide";
  $("#guide-cancel").hidden = true;
}
$("#guide-cancel").onclick = resetGuideForm;

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
    .subscribe();
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
