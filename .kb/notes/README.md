# Hand-written module notes

One file per module, named exactly like its generated counterpart in
`../modules/` — `apps.api.services.auth.md` here pairs with
`../modules/apps.api.services.auth.md`, and the generator links to it
automatically.

Write only what a parser cannot recover from the source:

- **Reuse pointers.** "Hashing anything token-shaped? `hashInviteToken`, not a
  fresh `createHash` call."
- **The trap.** "Every write here must be followed by `invalidateUserAccess`, or
  the caller keeps their old permissions for the cache TTL."
- **The seam.** "This is the only module allowed to call `@rcln/db/unsafe`."

Do not restate signatures, list exports, or explain a decision at length — the
first two are generated above your notes, and the third belongs in
`.kb/Architecture/decisions/`. If a note grows past a screen, it is an ADR wearing a
disguise.
