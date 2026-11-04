# Property, model and oracle tests

Most PwrGit tests are **example tests**: pick one input, write down the output
you expect. They check only the cases someone thought of, and they check what
the author *believed*. Three times in this repo's history, the expected output
was itself the bug, and the test kept it in place (table below).

The three ideas here let the computer choose the inputs. We use
[fast-check](https://fast-check.dev/) inside vitest.

## The three words

**Property.** A rule that must hold for *every* input, written as code.
fast-check generates hundreds of inputs. When one breaks the rule, it
*shrinks* that input to the smallest one that still fails, and prints it with
a seed so you can replay it.

> *"A query equal to a repo's name ranks that repo first."* Against the
> pre-#337 code, this shrank to exactly 60 checkouts named like the repo:
> the search SQL's `LIMIT 60`. Nobody told it about the limit.

**Model.** For code with state or concurrency, a small stand-in that is
obviously correct. The test generates random sequences of commands
(`fc.commands`) or random orderings of async work (`fc.scheduler`). It runs
each one on the real code and on the model, and checks that they agree after
every step.

> Commands: pull, fetch, status probe, remove repository. Rule: every request
> finishes, and no two git commands hold the same lock. Against the code
> before #486 and #542, it deadlocked on all 100 seeds, usually within 20
> runs, and shrank to `pull, removeRepository, pull`.

**Oracle.** Whatever tells the test what the right answer is. It can be one
of three things:

- **git itself.** Run the operations in a temp repo, then compare PwrGit's
  answer with git plumbing: `git stash list`, `git worktree list --porcelain`,
  `git rev-list --left-right --count`.
- **A slow, obviously correct version** of the function, such as plain graph
  reachability.
- **A second code path** that must give the same answer. Comparing two paths
  is called a *differential* test.

> *"PwrGit can drop any stash that `git stash list` shows."* This found #512
> in seconds, as `stash push; git gc; drop`.

The three work together. A property needs an oracle to say what "correct"
means, and a model test usually uses git as its oracle.

## What the history showed

Each test below ran against the code from just before the fix, extracted with
`git show`.

| Fix | Bug | Test | Found in |
| --- | --- | --- | --- |
| #512 | Drop/Pop refused a stash after `git gc`. A test asserted the refusal. Shipped in 27 releases. | Model, against real git | 3–38 runs; shrunk to `stash push; git gc; drop` |
| #280 | Beta installs stuck "up to date" after a promotion. Five `expect(...).toBeUndefined()` asserted it. | Property: no track offers less than Stable Latest | Run 2, with one release |
| #41 → #42, #50 → #52 | Two lineage fixes each broke the dash rule, which was fixed again the next day. | Property: dashed ⇔ fetched but not applied | 2–3 ms each |
| #486, #542 | Repository and worktree queues deadlocked. Three PRs wrote the same inverted lock order over 31 days. | Model with `fc.scheduler` | 100 of 100 seeds; median under 20 runs |
| #544 | `mapLimit` turned every worker error into success for 4 months, at 15 call sites. | Property | Run 1 |
| #467, #468 | Update Restart offered an installer that was no longer on disk. | Model with `fc.commands` | About 3 s |

## When to write one

- **Fixing a bug.** Write the rule the bug broke as a property or model
  invariant, and confirm it fails on the pre-fix code before you fix it. Also
  keep the shrunk counterexample as a plain example test, so the regression
  has a name.
- **Pure logic with rules:** layout, ranking, selection, release-slot choice,
  retry delays, path formatting, parsers. Write a property.
- **State and concurrency:** queues, locks, async races, update and quit flows,
  UI selection state. Write a model (`fc.commands`, `fc.scheduler`).
- **Anything that reads or re-derives git state.** git is the oracle. Generate
  repos with git commands in a temp dir, including shapes fixtures rarely
  build:
  - unborn and detached HEAD;
  - packed refs after `git gc`;
  - deleted worktree folders, with and without `worktree prune`;
  - renamed remotes;
  - linked worktrees sharing one stash stack.
- **Two places answer the same question,** such as SQL, main and renderer
  deciding "exact match", or Settings and Hosts reporting a forge. Write a
  differential test that they agree.
- **Before an `expect` pins a refusal, an empty result or an order,** say the
  rule in words. If the rule and the output disagree, the output is the bug.

## How to write them

- **Name the file `<module>.property.test.ts`**, next to the module. The
  root `vitest.config.ts` already includes it.
- **Build inputs the way users do.** Generate a list of operations (commit,
  branch, merge, pull, `stash push`, `git gc`) and replay it, not random
  structs. Don't generate states git can't produce: git merges an ancestor
  only with `--no-ff`, for example. Impossible states give false failures.
- **Take the property from a promise:** the code's comment, the design, or
  what the user wants. Never take it from today's output.
- **Narrow, don't weaken.** A counterexample may be a case the code handles
  on purpose. If so, restrict the generator or add `fc.pre(...)`, with a
  comment saying why. Don't loosen the assertion until it passes.
- **Budget the runs.**
  - Pure properties: keep the default `numRuns` (100), and a file under
    about 200 ms.
  - Real-git models: about 0.1 s per run. Keep `numRuns` around 50 and the
    file under 10 s, because the 20 s test timeout also applies on Windows CI.
- **Don't pin a seed in committed tests.** On failure, fast-check prints
  `seed` and `path`. Replay with `fc.assert(prop, { seed, path })`.
- **A property failure on an unrelated PR is a real bug.** Reproduce it from
  the printed seed and fix it or file it. Never re-run CI to get green.
- **Use the scheduler for time and ordering,** not real sleeps or timers.
- **fast-check is a devDependency** of the package that uses it. The seven-day
  `deps:maturity` cooldown applies ([scripts/AGENTS.md](../scripts/AGENTS.md)).
