import {
  contributionWindow,
  shiftContributionDate,
  type ContributionRepo,
  type ContributionSnapshot
} from "@pwrgit/shared";

/** Entirely invented metadata, for tests/screenshots only. Never reads a forge. */
export function contributionFixture(): ContributionSnapshot {
  const repos: ContributionRepo[] = Array.from({ length: 8 }, (_, index) => ({
    id: `DEMO_R${index}`,
    path: `demo-${index < 7 ? "org" + index : "user"}/${["orbit", "canvas", "relay", "atlas", "quartz", "rivet", "sprout", "notes"][index]}`,
    owner: `demo-${index < 7 ? "org" + index : "user"}`,
    ownerId: `DEMO_O${index}`,
    ownerKind: index < 7 ? "organization" : "user",
    visibility: "PRIVATE",
    fork: index === 6,
    archived: index === 5
  }));
  const snapshot: ContributionSnapshot = {
    version: 1,
    profileId: "demo-profile",
    identity: { id: "DEMO_U1", login: "demo-user", host: "github.com" },
    window: contributionWindow(
      "2026-04-11",
      "2026-10-10",
      "America/New_York",
      new Date("2026-10-11T16:00:00Z")
    ),
    startedAt: "2026-10-11T12:00:00Z",
    refreshedAt: "2026-10-11T12:08:00Z",
    status: "complete",
    repos,
    records: [],
    organizations: repos
      .filter((repo) => repo.ownerKind === "organization")
      .map((repo) => repo.owner),
    inventoryComplete: true,
    inventoryExpected: 8,
    inventoryReceived: 8,
    organizationsComplete: true,
    repoCursor: null,
    orgCursor: null,
    repoIndex: 8,
    prCursor: null,
    pages: 34,
    retryAt: null,
    issues: [],
    authoredInventory: {
      cursor: null,
      expected: 0,
      received: 0,
      seen: [],
      complete: true
    }
  };
  let number = 0;
  for (let day = 0; day < 183; day++) {
    const date = shiftContributionDate(snapshot.window.startDate, day);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const count = ((day * 7) % 13) + 2;
    for (let item = 0; item < count; item++) {
      number++;
      const index = item % 5 === 0 ? (day + item) % 8 : (day + item) % 3;
      const mergedAt = `${date}T${String(13 + (item % 7)).padStart(2, "0")}:30:00Z`;
      snapshot.records.push({
        id: `DEMO_P${number}`,
        number,
        repo: repos[index]!,
        mergedAt,
        mergedBy: item % 7 === 0 ? "DEMO_BOT" : "DEMO_U1",
        author: item % 3 === 0 ? "DEMO_U1" : "DEMO_U2",
        ...(item % 3 === 0
          ? {
              lifecycle: {
                createdAt: `${shiftContributionDate(date, -2)}T12:00:00Z`,
                updatedAt: mergedAt,
                closedAt: mergedAt,
                state: "MERGED" as const,
                events: [
                  {
                    id: `DEMO_M${number}`,
                    kind: "merged" as const,
                    at: mergedAt
                  }
                ],
                complete: true,
                cursor: null
              }
            }
          : {})
      });
    }
  }
  for (const [id, createdAt, state, events, frozenState] of [
    ["DEMO_OLD_OPEN", "2025-01-01T12:00:00Z", "OPEN", [], "OPEN"],
    ["DEMO_OLD_CLOSED", "2025-02-01T12:00:00Z", "CLOSED", [], "CLOSED"],
    [
      "DEMO_REOPENED",
      "2026-06-01T12:00:00Z",
      "OPEN",
      [
        { id: "DEMO_E1", kind: "closed", at: "2026-07-01T12:00:00Z" },
        { id: "DEMO_E2", kind: "reopened", at: "2026-09-01T12:00:00Z" }
      ],
      undefined
    ],
    ["DEMO_NEW_OPEN", "2026-09-15T12:00:00Z", "OPEN", [], undefined]
  ] as const) {
    snapshot.records.push({
      id,
      number: ++number,
      repo: repos[7]!,
      author: "DEMO_U1",
      mergedBy: null,
      mergedAt: null,
      lifecycle: {
        createdAt,
        updatedAt: frozenState
          ? "2025-03-01T12:00:00Z"
          : "2026-09-15T12:00:00Z",
        closedAt: state === "CLOSED" ? "2025-03-01T12:00:00Z" : null,
        state,
        events: [...events],
        complete: true,
        cursor: null,
        ...(frozenState ? { frozenState } : {})
      }
    });
  }
  snapshot.authoredInventory.seen = snapshot.records
    .filter((row) => row.author === "DEMO_U1")
    .map((row) => row.id);
  snapshot.authoredInventory.expected = snapshot.authoredInventory.received =
    snapshot.authoredInventory.seen.length;
  return snapshot;
}
