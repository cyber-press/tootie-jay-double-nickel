# Tootie Jay's Double Nickel · 90's Birthday Bash

Invitation site for Tootie Jay's 55th, hosted by Tenisia Ruiz. Saturday, March 27, 2027 · Kitty Hawk Event Center, Universal City, TX.

Powered by [PressCreates](https://presscreates.com).

- `public/` is the site (one page with eight sections, plus fonts and photos).
- `netlify/functions/api.mjs` stores the host's site edits and photos in Netlify Blobs. Anyone can read them. Saving needs the host key, which is checked against the Google Apps Script backend that also runs RSVPs, the memory wall and the Host Desk.
- The host edits the site from the footer: **Edit site**, then sign in with the host key.
- `test/server.mjs` runs the site and the function locally with an in-memory store. Its test host key is `test-host-key`.
