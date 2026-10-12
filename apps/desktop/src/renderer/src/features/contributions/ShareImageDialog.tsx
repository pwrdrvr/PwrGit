import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  contributionShareChart,
  contributionShareOwnerLabels,
  contributionShareOwners,
  defaultShareNameMode,
  type ContributionOptions,
  type ContributionShareGroup,
  type ContributionShareNameMode,
  type ContributionSnapshot
} from "@pwrgit/shared";
import { CloseGlyph } from "../../lib/CloseGlyph";
import { useModal } from "../../lib/useModal";
import { copyPngToClipboard } from "../diff/image-clipboard";
import { downloadFile } from "./download";
import {
  SHARE_IMAGE_HEIGHT,
  SHARE_IMAGE_SCALE,
  SHARE_IMAGE_WIDTH,
  shareImagePng,
  shareImageSvg,
  shareImageTitle,
  shareYAxisLabel,
  type ShareTheme
} from "./share-image";

type SharePrefs = {
  names: Record<string, ContributionShareNameMode>;
  showLogin: boolean;
  theme: ShareTheme;
};
const DEFAULT_PREFS: SharePrefs = {
  names: {},
  showLogin: true,
  theme: "light"
};

/**
 * Per profile, host and account: the same org can be fine to name from one
 * account and not from another. An org the user never touched has no entry,
 * so it falls to `defaultShareNameMode` — masked — on every open.
 */
const prefsKey = (profileId: string, snapshot: ContributionSnapshot) =>
  `pwrgit.contributions.share.${profileId}.${snapshot.identity.host}.${snapshot.identity.id}`;

function readPrefs(key: string): SharePrefs {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<SharePrefs>;
    const names: SharePrefs["names"] = {};
    for (const [ownerId, mode] of Object.entries(parsed.names ?? {})) {
      if (mode === "show" || mode === "mask") names[ownerId] = mode;
    }
    return {
      names,
      showLogin: parsed.showLogin !== false,
      theme: parsed.theme === "dark" ? "dark" : "light"
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const GROUPS: { value: ContributionShareGroup; label: string }[] = [
  { value: "org", label: "Organization" },
  { value: "repo", label: "Repository" },
  { value: "none", label: "Total only" }
];
const GROUP_HINTS: Record<ContributionShareGroup, string> = {
  org: "Personal namespaces stay separate from orgs.",
  repo: "Top 8 repositories by volume; the rest stack as Other.",
  none: "One color, no legend. No org or repository name appears anywhere."
};
const THEMES: { value: ShareTheme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

/** A row of radio buttons drawn as one segmented control. */
function Segments<T extends string>({
  name,
  label,
  value,
  options,
  onChange
}: {
  name: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="contributions-share__segments"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <label key={option.value} className="contributions-share__segment">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export function ShareImageDialog({
  profileId,
  snapshot,
  options,
  onClose
}: {
  profileId: string;
  snapshot: ContributionSnapshot;
  options: ContributionOptions;
  onClose: () => void;
}) {
  const id = useId();
  const storageKey = prefsKey(profileId, snapshot);
  const [prefs, setPrefs] = useState(() => readPrefs(storageKey));
  const [group, setGroup] = useState<ContributionShareGroup>(
    options.group === "repo" ? "repo" : "org"
  );
  const [status, setStatus] = useState<"idle" | "working" | "copied">("idle");
  const [error, setError] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useModal<HTMLDivElement>({ onClose });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(prefs));
    } catch {
      // Private mode or a full store: the choices last for this dialog only.
    }
  }, [storageKey, prefs]);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    []
  );

  // The screen's measure, interval and namespace/repository filters carry
  // over; how the picture stacks is this dialog's choice.
  const { metric = "merged", interval = "day", ownerId, repoId } = options;
  const shareOptions = useMemo<ContributionOptions>(
    () => ({
      metric,
      interval,
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(repoId === undefined ? {} : { repoId })
    }),
    [metric, interval, ownerId, repoId]
  );
  const owners = useMemo(
    () =>
      contributionShareOwners(
        snapshot.records,
        snapshot.identity,
        snapshot.window,
        shareOptions
      ),
    [snapshot, shareOptions]
  );
  const ownerLabels = useMemo(
    () => contributionShareOwnerLabels(owners, prefs.names),
    [owners, prefs.names]
  );
  const chart = useMemo(
    () =>
      contributionShareChart(
        snapshot.records,
        snapshot.identity,
        snapshot.window,
        shareOptions,
        group,
        prefs.names
      ),
    [snapshot, shareOptions, group, prefs.names]
  );
  const title = shareImageTitle({
    metric,
    login: prefs.showLogin ? snapshot.identity.login : null,
    group,
    interval,
    window: snapshot.window
  });
  const svg = useMemo(
    () =>
      shareImageSvg(chart, {
        title,
        yLabel: shareYAxisLabel(metric),
        interval,
        theme: prefs.theme
      }),
    [chart, title, metric, interval, prefs.theme]
  );
  const preview = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const total = chart.buckets.reduce((sum, bucket) => sum + bucket.total, 0);

  const setName = (ownerId: string, mode: ContributionShareNameMode) => {
    setStatus("idle");
    setPrefs((previous) => ({
      ...previous,
      names: { ...previous.names, [ownerId]: mode }
    }));
  };
  const setAll = (mode: ContributionShareNameMode) => {
    setStatus("idle");
    setPrefs((previous) => ({
      ...previous,
      names: {
        ...previous.names,
        ...Object.fromEntries(owners.map((owner) => [owner.ownerId, mode]))
      }
    }));
  };

  const run = async (action: (png: Blob) => Promise<boolean>) => {
    if (status === "working") return;
    setStatus("working");
    setError(null);
    try {
      if (!(await action(await shareImagePng(svg))))
        throw new Error("rejected");
      return true;
    } catch {
      setStatus("idle");
      setError("Could not make the image. Try again.");
      return false;
    }
  };
  const copy = async () => {
    if (!(await run(copyPngToClipboard))) return;
    setStatus("copied");
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setStatus("idle"), 2000);
  };
  const save = async () => {
    if (
      await run(async (png) => {
        downloadFile("pwrgit-contributions.png", png, "image/png");
        return true;
      })
    )
      setStatus("idle");
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="modal contributions-share"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="contributions-share__header">
          <h2 id={`${id}-title`}>Share image</h2>
          <button
            type="button"
            className="contributions-share__close"
            aria-label="Close"
            onClick={onClose}
          >
            <CloseGlyph />
          </button>
        </header>
        <div className="contributions-share__body">
          <figure className="contributions-share__preview">
            <figcaption>
              <span>Preview · exactly what is copied</span>
              <span>
                PNG · {SHARE_IMAGE_WIDTH * SHARE_IMAGE_SCALE} ×{" "}
                {SHARE_IMAGE_HEIGHT * SHARE_IMAGE_SCALE}
              </span>
            </figcaption>
            <img
              src={preview}
              alt={`${title}. ${total} pull requests.`}
              width={SHARE_IMAGE_WIDTH}
              height={SHARE_IMAGE_HEIGHT}
            />
          </figure>
          <div className="contributions-share__controls">
            <section>
              <h3>Break down by</h3>
              <Segments
                name={`${id}-group`}
                label="Break down by"
                value={group}
                options={GROUPS}
                onChange={(value) => {
                  setStatus("idle");
                  setGroup(value);
                }}
              />
              <p>{GROUP_HINTS[group]}</p>
            </section>
            {group !== "none" && owners.length > 0 && (
              <section>
                <div className="contributions-share__heading">
                  <h3>Names in the image</h3>
                  <span>
                    <button type="button" onClick={() => setAll("show")}>
                      Show all
                    </button>
                    <button type="button" onClick={() => setAll("mask")}>
                      Mask all
                    </button>
                  </span>
                </div>
                <ul className="contributions-share__owners">
                  {owners.map((owner) => {
                    const mode =
                      prefs.names[owner.ownerId] ?? defaultShareNameMode(owner);
                    return (
                      <li key={owner.ownerId}>
                        <span className="contributions-share__owner">
                          <strong>{owner.owner}</strong>
                          <small>
                            {mode === "mask"
                              ? `appears as “${ownerLabels.get(owner.ownerId)}”`
                              : `${owner.viewer ? "your namespace · " : ""}${owner.total} PRs`}
                          </small>
                        </span>
                        <Segments
                          name={`${id}-name-${owner.ownerId}`}
                          label={`${owner.owner} in the image`}
                          value={mode}
                          options={[
                            { value: "show", label: "Show" },
                            { value: "mask", label: "Mask" }
                          ]}
                          onChange={(value) => setName(owner.ownerId, value)}
                        />
                      </li>
                    );
                  })}
                </ul>
                <p>
                  Masked orgs become Org A, Org B… by volume, and their
                  repositories Org A/repo 1…. Choices are remembered for this
                  account.
                </p>
              </section>
            )}
            <section>
              <h3>Title</h3>
              <label className="contributions-share__check">
                <input
                  type="checkbox"
                  checked={prefs.showLogin}
                  onChange={(event) => {
                    const showLogin = event.target.checked;
                    setStatus("idle");
                    setPrefs((previous) => ({ ...previous, showLogin }));
                  }}
                />
                Name the account ({snapshot.identity.login})
              </label>
            </section>
            <section>
              <h3>Background</h3>
              <Segments
                name={`${id}-theme`}
                label="Background"
                value={prefs.theme}
                options={THEMES}
                onChange={(theme) => {
                  setStatus("idle");
                  setPrefs((previous) => ({ ...previous, theme }));
                }}
              />
            </section>
          </div>
        </div>
        <footer className="contributions-share__footer">
          <p>
            <strong>Names are replaced before drawing.</strong> The PNG holds
            pixels only: no hidden labels, tooltips or metadata.
          </p>
          {error !== null && (
            <p role="alert" className="contributions-share__error">
              {error}
            </p>
          )}
          <span role="status" className="contributions-share__status">
            {status === "copied" ? "Copied to the clipboard" : ""}
          </span>
          <button
            type="button"
            aria-disabled={status === "working"}
            onClick={() => void save()}
          >
            Save PNG
          </button>
          <button
            type="button"
            className="contributions__primary"
            aria-disabled={status === "working"}
            onClick={() => void copy()}
          >
            {status === "copied" ? "Copied" : "Copy image"}
          </button>
        </footer>
      </div>
    </div>
  );
}
