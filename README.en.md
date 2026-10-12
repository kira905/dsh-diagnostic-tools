# dsh-diagnostic-tools

> **Status**: published (Gitee + GitHub) · repo-level tag `v0.1.2` (closure `0.1.0` / attachments `0.1.0`)
> **Repository**: <https://github.com/kira905/dsh-diagnostic-tools> ｜ <https://gitee.com/kira905/dsh-diagnostic-tools>
> **License**: MIT — see [`LICENSE`](./LICENSE)
> **中文**: [README.md](./README.md)

> **In one line**: one repository, two subdirectories, answering the two questions anyone who runs a coding
> agent long-term will eventually ask — **is my environment broken** (dependency closure / decoupling) ·
> **is my data incomplete** (session image entities).
>
> **Zero npm dependencies** (Node standard library only) · **read-only by default** (a write requires an explicit `--apply` and leaves a rollback list) ·
> **no network access** · **criteria you can re-run** (each subdirectory ships its own verification scripts, so you never have to take the maintainer's word for it).

---

## Design basis

This toolkit is one implementation of the operations system described in
[ops-handoff-design](https://github.com/kira905/ops-handoff-design),
and its design basis is the fixed four questions that documentation repository prescribes:

- **Why it exists and where its boundary is** → see *Design Discipline for a Read-Only Monitoring Panel* **§2 display discipline (not probeable + why)**, **§5 the three classes of data source (where the ceiling on "generalization" sits)**
- **Its compatibility window with the host** → see *Multi-machine Handoff and Cloud Relay* **§4.5 "compatibility requirements"** (see also section 6, "Current state and limits", below)
- **This component's own pitfalls and measurements** → see the "limits, stated honestly" and "host-version applicability" sections of each subdirectory README; both subdirectories keep host-related names **concentrated in a single file**, precisely so that the regression surface at upgrade time stays small
- **Documentation repository** → Gitee (mirror) <https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub (primary) <https://github.com/kira905/ops-handoff-design>
  (the documentation repository's component index links back to this repository; the two repositories cross-link, and their versions are independent)

> Design drafts carry no concrete repository URLs (hard-coding one produces a dead link); the implementation list is kept together in the documentation repository's component index — this repository only owns the back-links.

---

## 1. Which one do you need?

| What you are seeing | Which subdirectory | Entry point |
|---|---|---|
| After a host (main package) upgrade, a plugin **crashes on startup** / its verdicts quietly lose accuracy / it crashes on restart after switching machines | **`closure/`** — dependency-closure checks, 4 tools | `node closure/closure-check.mjs` |
| A **historical session containing images** reports a transport error as soon as you keep chatting (you switched machines, or have used two) | **`attachments/`** — attachment reconciliation, 2 tools | `node attachments/attachments-audit.mjs` |

What the two have in common: **the symptom looks like something else** (one looks like "a poor-quality plugin", the other like "a network failure"),
and troubleshooting in the direction the surface suggests never fixes it — so each ships a **read-only** tool that turns the facts into something you can see.

Three of the most counter-intuitive conclusions (read these three before deciding whether to read on):

1. **"The plugin crashed after a host upgrade" is usually not a bad plugin** — it `import`ed a **runtime symbol** of the host, and the host deleted / renamed / split that symbol into another package.
2. **When several installations coexist, starting one of them rewrites the shared dependency-closure links** — hence "once the test instance has run, the production install crashes on restart".
3. **"A session with images reports a transport error when you keep chatting" is not a network failure**: image entities live only on the local disk, and synchronization schemes do not move these large binaries by default ⇒ after switching machines the references dangle.

---

## 2. Layout and installation

```
dsh-diagnostic-tools/
├─ README.md            repository-level description (this file)
├─ LICENSE              repository-level license (MIT)
├─ CHANGELOG.md         repository level: structural changes only
├─ docs/RELEASING.md    repository-level release process
├─ closure/             dependency-closure checks, 4 tools (decoupling check / closure-link check / repair / shared criteria library)
│  ├─ README.md · CHANGELOG.md · LICENSE · docs/RELEASING.md
│  ├─ check-decoupling.mjs · closure-check.mjs · repair-closure-links.mjs
│  ├─ lib/ · scripts/ · examples/
└─ attachments/         session-image attachment reconciliation, 2 tools (read-only reconciliation + on-demand fetch)
   ├─ README.md · CHANGELOG.md · LICENSE · docs/RELEASING.md
   ├─ attachments-audit.mjs · attachments-fetch.mjs
   └─ lib/ · scripts/
```

**Installation** (zero dependencies, no build step):

```bash
git clone https://github.com/kira905/dsh-diagnostic-tools
cd dsh-diagnostic-tools
node closure/closure-check.mjs --help        # or node attachments/attachments-audit.mjs --help
```

Each subdirectory README carries the full **usage table / arguments / exit-code meanings / known limitations**.
`--help` and `--dry-run` are safe: **every write operation requires an explicit `--apply`**, and the tool first prints what it is about to do together with a rollback list.

---

## 3. Why one repository (instead of one per tool)

**Reasons**

1. Both belong to the same idea — "install it once and you can check two classes of problem yourself": **is my environment broken** (closure / decoupling) + **is my data incomplete** (attachment entities);
2. The repository-level `README` / `LICENSE` / release process / self-check script shape are shared, so the maintenance cost is lower;
3. The audiences for the two classes of tool overlap heavily (both arise in setups with several machines, several installations and a long-running agent).

**Costs and how they are handled**

- The two subdirectories keep **independent version numbers and exit codes** (different criteria, different change cadence) ⇒ subdirectory-level `CHANGELOG.md` files are kept,
  and the repository-level `CHANGELOG.md` records only **structural** changes (a new subdirectory, a repository rename, a license change);
- Cloning once gets you one tool you may not need ⇒ the table in §1 routes you, and each subdirectory README gives its own "three-line install + usage table".

---

## 4. License

**MIT** (see `LICENSE`). Each subdirectory also carries its own copy of the same `LICENSE` text, so either can be taken on its own;
**once combined into this repository, the repository-root `LICENSE` is authoritative**, and changing the license means changing all three places (see `docs/RELEASING.md` §2).

---

## 5. Versions and releases

- **Subdirectories** follow SemVer independently (both are currently **0.1.0**, the first public version);
- The **repository level** uses tags to record structural state (currently `v0.1.2` = closure 0.1.0 / attachments 0.1.0; a repository-level tag only moves forward together with updates to the repository-root documents);
- The release process and checklist are in [`docs/RELEASING.md`](./docs/RELEASING.md); **releases only — there is no npm package.**

## 6. Current state and limits

- `closure/` — dependency-closure checks, 4 tools, already generalized; ships static verification (syntax + configuration behaviour + sanitization scan)
  and clean-fixture verification (4 verdicts + dry-run makes no changes).
- `attachments/` — attachment reconciliation, 2 tools, as above; additionally cross-checked with a read-only reconciliation run on an **isolated real instance** (production data untouched).
- **Limits, stated honestly**: the criteria of both subdirectories are based on the event names / service names / directory shapes of the **current host version**.
  A host upgrade can change these **string contracts** — which is exactly what `closure/` exists to check, and why
  each subdirectory keeps host-related names **in a single file** (`lib/host-protocol.*` / `lib/closure-links.mjs`)
  rather than scattering them through the feature code.

---

## 7. Related components

Sibling components in the same DSH ecosystem — separate repositories, separate versions, separate licenses. All of them link back to the same documentation repository,
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
(Gitee mirror: <https://gitee.com/kira905/ops-handoff-design>):

| Repository | What it does | How it relates to this toolkit |
|---|---|---|
| `dsh-diagnostic-tools` | Dependency-closure checks + session-image attachment reconciliation | **this repo** |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | Read-only ecosystem overview panel (continuous, three-colour, persists nothing) | Complementary division of labour: it answers **"how is today going"** (continuous observation, renders only, never recomputes), while this repo answers **"what exactly is broken, and how do I fix it"** (offline, re-runnable, ships the fix and a rollback list) — both only diagnose; neither writes to the other |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | Session archiving (list / preview / restore / delete, plus optional auto-archive) | It is one of the subjects `closure/` checks: a component registered through an `insert` in `cordis.patch.yml` is the most likely to end up "missing on disk, silent at startup" after a host orchestration change |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | Session titles that update live with the conversation | Same as above: it concentrates the host contract in `lib/host-protocol.js`, and that constant list **carries the same class of risk that `closure/` checks for** (a string contract that breaks after a host upgrade) |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | Self-maintained task board (a card = one real session + a human acceptance gate) | It is the representative "self-built + insert-registered" component and therefore a **primary subject** of `closure/` and of the host-contract checks; its missing execution record (after a cross-machine merge) once surfaced a flaw in this repo's criteria — see *Telling a "finished" task card from a lie, and an interrupted session from a closed one* |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | Zero-dependency incident toolkit: four on-site scenarios — will not start / frozen / need to undo a change / data got deleted — compressed into one entry point | Division of labour: this repo is the **offline, targeted checkup** (run it proactively before and after an upgrade); that one is **on-site triage** (run it first once something has already broken) — neither acts; both produce evidence only |

> There are **no code dependencies** between these components and they share no runtime — they point at each other because they answer the same class of question for the same kind of person
> (running an agent on your own machine long-term: install it, find it, see it, diagnose it). Installing one does not affect the others.
