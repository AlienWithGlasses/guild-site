# Guild website

A members-only website for the guild: guides, YouTube videos, a public chat
for questions, and private messages between the owner and each member.

- **Website files** (`index.html`, `app.js`, `style.css`, `config.js`) are static,
  so GitHub Pages can host them for free.
- **Accounts, codes, messages, guides and videos** live in a free
  [Supabase](https://supabase.com) project. Supabase stores passwords as bcrypt
  hashes; the website never sees or saves a plain password.

## How it works

| Who | Can do |
|---|---|
| Visitor (not logged in) | Only see the log-in page. |
| New player | Enter an activation code from the owner, pick a name and password. Each code works once. |
| Member | Read guides, watch videos, post in public chat, send private messages to the owner, delete their own messages. |
| Owner | Everything above, plus: make and cancel activation codes, write/edit/delete guides, post/remove videos, private-message any member, delete any message. |

The **first account ever created becomes the owner**. That account uses the
starter code `FOUNDER-START` that the database setup creates.

These rules are enforced in the database (Row Level Security), not just hidden
in the page, so a player can't get around them with browser tricks.

## One-time setup (about 10 minutes)

1. **Create a Supabase project.** Sign up at supabase.com, click *New project*,
   pick any name and a strong database password.
2. **Turn off email confirmation.** Members log in with a name, not an email, so:
   *Authentication → Sign In / Providers → Email* → switch off **Confirm email** → Save.
3. **Create the database.** *SQL Editor → New query*, paste all of
   `supabase/schema.sql`, click **Run**. (Optional: change `FOUNDER-START`
   at the bottom to your own secret first.)
4. **Connect the website.** *Project Settings → API*: copy the **Project URL**
   and the **anon public** key into `config.js`. Never use the `service_role` key.
5. **Put the site on GitHub Pages.** Push these files to a repository in your
   organization, then *Settings → Pages → Deploy from a branch → main / (root)*.
6. **Create your owner account.** Open the site, choose *Join with a code*,
   enter `FOUNDER-START`, pick your name and password.
7. **Invite players.** *Owner tools → Make a new code*, and send each player
   their own code.

## Notes and limits of this first version

- Guides are plain text (line breaks are kept). Formatting like bold or images
  could be added later.
- A forgotten password can't be reset by email, since members have no email.
  For now the owner can delete that user in Supabase (*Authentication → Users*)
  and give the player a new code. An owner "reset password" button can be added later.
- Names are 3 to 20 letters, numbers or `_`. Passwords need at least 8 characters.
- Chat updates live while the page is open.
