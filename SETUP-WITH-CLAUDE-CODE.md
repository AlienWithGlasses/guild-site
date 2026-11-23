# Task: set up and publish the guild website

You are Claude Code running on the guild owner's own computer. This folder
holds a finished website (`index.html`, `app.js`, `style.css`, `config.js`,
`supabase/schema.sql`). Your job is to create the online services it needs
and publish it, using the **Playwright CLI** to drive a **visible** browser
window the owner can watch and type into.

## Fill these in before starting (ask the owner if blank)

- Owner email for the new accounts: `snugger.curler.7s@icloud.com`
- GitHub organization: `__________`
- Repository name: `__________` (suggestion: `guild-site`)

## Ground rules (follow these exactly)

1. **Always run the browser headed** (visible) with a saved profile folder
   (for example `./.pw-profile`, add it to `.gitignore`) so sign-ins persist
   between steps. Never run headless for sign-up or sign-in pages.
2. **The owner types every password, email code and "I'm not a robot" check
   themselves.** When a page asks for any of these, stop, tell the owner in
   one line what to do in the browser window, and wait until they say "done".
   Never try to solve or skip a CAPTCHA.
3. **Never write a password into a file, the chat, a commit or a log.** The
   only secrets you may copy are the Supabase **Project URL** and **anon
   public** key, which are designed to be public. Never copy the
   `service_role` key or the database password anywhere.
4. Before each step that creates something (an account, a project, a
   repository, a push), say what you're about to do and wait for "ok".
5. If a page looks different from these steps, take a screenshot, describe
   what you see, and ask the owner instead of guessing.

## Step 1: Supabase account and project

1. Open `https://supabase.com/dashboard/sign-up`.
2. Prefer **Continue with GitHub** (no new password). Otherwise the owner
   signs up with the email above and confirms the code from their inbox.
3. Create an organization if asked (Free plan), then **New project**:
   - Name: the repository name.
   - Database password: click **Generate a password**. The owner may save
     it in their password manager. It is not needed for the website.
   - Region: the closest one to the guild's players.
4. Wait until the project finishes setting up (a few minutes).

## Step 2: Supabase settings

1. **Authentication → Sign In / Providers → Email**: turn **off**
   "Confirm email" and click Save. (Members log in with a name, so no
   email is ever sent.) Leave "Allow new users to sign up" **on**; the
   database only accepts sign-ups that use a valid activation code.
2. **SQL Editor → New query**: paste the full contents of
   `supabase/schema.sql`, click **Run**, and confirm it reports success.
   (Ask the owner first whether they want to replace the starter code
   `FOUNDER-START` near the bottom with their own secret word.)
3. **Project Settings → API** (or **Data API**/**API Keys**): read the
   **Project URL** and the **anon public** key, and put them into
   `config.js` as `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

## Step 3: GitHub repository

1. If the `gh` CLI is installed and signed in (`gh auth status`), use it.
   Otherwise use the browser at `https://github.com/organizations/<ORG>/repositories/new`.
2. Create a **public** repository `<ORG>/<REPO>` (GitHub Pages is free for
   public repositories; the site itself still requires a login).
3. In this folder: `git init`, create `.gitignore` containing `.pw-profile/`,
   commit all site files, add the remote and push to `main`.

## Step 4: Turn on GitHub Pages

1. Open `https://github.com/<ORG>/<REPO>/settings/pages`.
2. Source: **Deploy from a branch**, branch **main**, folder **/ (root)**, Save.
3. Wait 1 to 3 minutes, then open `https://<ORG>.github.io/<REPO>/`
   (lowercase org name).

## Step 5: Owner account and check

1. On the live site, the owner clicks **Join with a code**, enters
   `FOUNDER-START` (or their own word), and picks their name and password.
   The first account becomes the owner.
2. Check with the owner watching: the top bar shows **Owner tools**; making
   a new code works; posting a guide, a YouTube link and a public message
   all work.
3. Tell the owner the live site address and that invites are made in
   **Owner tools → Make a new code**.

## Done when

- The site loads at the GitHub Pages address with no "Setup needed" banner.
- The owner can log in and sees Owner tools.
- No password or `service_role` key appears in any file or commit
  (`git grep -i -e service_role -e password` shows only code, not secrets).
