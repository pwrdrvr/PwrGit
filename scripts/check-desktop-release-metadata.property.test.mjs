import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkReleaseMetadata,
  extractChangelogSection,
  readReleaseMetadataSources,
  RELEASE_METADATA_SOURCES,
} from "./check-desktop-release-metadata.mjs";
import {
  applyVariant,
  BOM,
  proseLine,
  semver,
  textVariant,
  toCrlf,
} from "./test-support/line-endings.mjs";

// The repository's own sources are the valid baseline; the generators below
// vary only what a release legitimately varies (version, changelog, job
// order, unrelated jobs) and what a checkout varies (line endings, BOM).
const repo = readReleaseMetadataSources();
const SOURCE_KEYS = Object.keys(RELEASE_METADATA_SOURCES);

/** release.yml split into its preamble and one block per job. */
function splitJobs(workflow) {
  const jobsAt = workflow.indexOf("\njobs:\n") + "\njobs:\n".length;
  const preamble = workflow.slice(0, jobsAt);
  const blocks = workflow.slice(jobsAt).split(/^(?=  [A-Za-z0-9_-]+:)/m);
  return { preamble, jobs: blocks.map((block) => ({ name: /^ {2}([^:]+):/.exec(block)[1], block })) };
}
const workflowJobs = splitJobs(repo.releaseWorkflow);

/** A job nobody checks: some steps, comments and blank lines. */
const unrelatedJob = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/),
    fc.array(
      fc.oneof(
        proseLine.map((line) => `      - run: echo ${line.replaceAll("`", "")}`),
        proseLine.map((line) => `      # ${line}`),
        fc.constant(""),
      ),
      { maxLength: 6 },
    ),
  )
  .map(([name, steps]) => ({
    name: `extra-${name}`,
    block: [`  extra-${name}:`, "    runs-on: ubuntu-latest", "    steps:", ...steps, ""].join("\n") + "\n",
  }));

/**
 * Job order and unrelated jobs, by name. `dropOne` lets one checked job go
 * missing, which the gate must report.
 */
const workflowShape = ({ dropOne }) =>
  fc.record({
    order: fc.shuffledSubarray(
      workflowJobs.jobs.map(({ name }) => name),
      { minLength: workflowJobs.jobs.length - (dropOne ? 1 : 0), maxLength: workflowJobs.jobs.length },
    ),
    extra: fc.array(unrelatedJob, { maxLength: 3 }),
    at: fc.nat(),
  });

function buildWorkflow({ order, extra, at }) {
  const jobs = order.map((name) => workflowJobs.jobs.find((job) => job.name === name));
  jobs.splice(at % (jobs.length + 1), 0, ...extra);
  // Every block ends in a newline, so the joined jobs stay one per line.
  return workflowJobs.preamble + jobs.map(({ block }) => (block.endsWith("\n") ? block : `${block}\n`)).join("");
}

/** A changelog of release sections, newest first. */
const changelogSections = fc.uniqueArray(
  fc.record({
    version: semver,
    date: fc.constantFrom(" - 2026-11-05", ""),
    lines: fc.array(
      fc.oneof(
        proseLine.map((line) => `- ${line}`),
        proseLine.map((line) => `### ${line}`),
        proseLine,
        fc.constant(""),
      ),
      { maxLength: 6 },
    ),
  }),
  { selector: (section) => section.version, minLength: 1, maxLength: 4 },
);

/**
 * A release, as a small description: fast-check prints this, not the files,
 * when it finds a counterexample. `buildRelease` turns it into sources.
 */
const release = fc.record({
  sections: changelogSections,
  workflow: workflowShape({ dropOne: true }),
  pick: fc.nat(),
  packageVersion: fc.option(semver, { nil: undefined, freq: 4 }),
});

/** A release with every checked job and a matching package version. */
const completeRelease = fc.record({
  sections: changelogSections,
  workflow: workflowShape({ dropOne: false }),
  pick: fc.nat(),
});

function buildRelease({ sections, workflow, pick, packageVersion }) {
  const version = sections[pick % sections.length].version;
  const desktopPackage = JSON.parse(repo.desktopPackage);
  desktopPackage.version = packageVersion ?? version;
  return {
    tag: `v${version}`,
    sources: {
      ...repo,
      desktopPackage: `${JSON.stringify(desktopPackage, null, 2)}\n`,
      releaseWorkflow: buildWorkflow(workflow),
      changelog: [
        "# Changelog",
        "",
        ...sections.flatMap(({ version: v, date, lines }) => [`## v${v}${date}`, "", ...lines, ""]),
      ].join("\n"),
    },
  };
}

const perFileVariant = fc.record(Object.fromEntries(SOURCE_KEYS.map((key) => [key, textVariant()])));

function rewrite(sources, variants) {
  return Object.fromEntries(
    Object.entries(sources).map(([key, text]) => [key, applyVariant(variants[key], text)]),
  );
}

describe("release metadata gate (property)", () => {
  it("reaches the same verdict however each file's line endings, BOM and final newline are written", () => {
    fc.assert(
      fc.property(release, perFileVariant, (shape, variants) => {
        const { tag, sources } = buildRelease(shape);
        expect(checkReleaseMetadata(tag, rewrite(sources, variants))).toEqual(
          checkReleaseMetadata(tag, sources),
        );
      }),
    );
  });

  it("passes every well-formed release, whatever its job order and unrelated jobs", () => {
    fc.assert(
      fc.property(completeRelease, (shape) => {
        const { tag, sources } = buildRelease(shape);
        const { failures } = checkReleaseMetadata(tag, sources);
        // A section of only blank lines is a release with no notes: the gate
        // is right to refuse it.
        const notes = extractChangelogSection(sources.changelog, tag.slice(1));
        expect(failures).toEqual(
          notes === "" ? [`CHANGELOG.md section for ${tag} must contain release notes`] : [],
        );
      }),
    );
  });
});

describe("release metadata gate (shrunk counterexamples)", () => {
  const tag = `v${JSON.parse(repo.desktopPackage).version}`;

  it("still finds every Windows job in a CRLF release.yml (#96)", () => {
    // What 5741c19^ reported for a Windows checkout: `windows-prepare` and
    // every job after it "missing", because `^  name:\n` never matched `\r\n`.
    expect(
      checkReleaseMetadata(tag, { ...repo, releaseWorkflow: toCrlf(repo.releaseWorkflow) }).failures,
    ).toEqual([]);
  });

  it("still finds concurrency.jobs in a CRLF electron-builder.yml", () => {
    // #96 normalized only release.yml; this snippet check arrived later (#218)
    // and failed the same way.
    expect(
      checkReleaseMetadata(tag, { ...repo, electronBuilder: toCrlf(repo.electronBuilder) }).failures,
    ).toEqual([]);
  });

  it("reads a package.json that starts with a byte-order mark", () => {
    // JSON.parse throws on a BOM; npm and pnpm both accept one.
    expect(
      checkReleaseMetadata(tag, { ...repo, desktopPackage: `${BOM}${repo.desktopPackage}` }).failures,
    ).toEqual([]);
  });

  it("extracts the same release notes from a CRLF changelog", () => {
    const version = tag.slice(1);
    expect(extractChangelogSection(toCrlf(repo.changelog), version)).toBe(
      extractChangelogSection(repo.changelog, version),
    );
  });
});
