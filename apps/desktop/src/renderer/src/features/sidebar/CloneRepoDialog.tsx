import { useEffect, useMemo, useRef, useState } from "react";
import {
  forgeLabel,
  isForgeKind,
  forgeProductFor,
  type CloneCatalog,
  type CloneDestination,
  type CloneProgress,
  type CloneProtocol,
  type CloneRepository,
  type ForgeHost,
  type ForgeKind,
  type ForgeOwner,
  type ForkPreflight,
  type ForkProgress,
  type Profile,
  type Repo,
  type SshHostVerification
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { joinDisplayPath } from "../../lib/platform";
import {
  cloneDestinationLabel,
  cloneDestinationSelectionIndex,
  cloneRepositoryAtSelection,
  defaultHostname,
  exactRepository,
  filterCloneDestinations,
  localRepositoryPath,
  moveCloneSelection,
  rankCloneRepositories,
  sshHostVerificationCommand,
  unverifiedCloneRepository
} from "./clone-dialog";
import type { ExactRepository } from "./clone-dialog";
import {
  cliProtocolLabel,
  defaultForkTarget,
  defaultUpstream,
  forkAction,
  forkTargets,
  FORK_PROGRESS_LABELS,
  ownerKindLabel,
  sourceEmptyMessage,
  statusFor,
  forgeCanAnswerAnywhere,
  forgeCanAnswerDialog
} from "./fork-dialog";
import {
  canPushOriginal,
  cloneFromDefault,
  forkCardDetail,
  forkCardPill,
  forkCardState,
  forkOriginRepository,
  offersCloneFrom,
  originalCardDetail,
  type CloneFrom
} from "./clone-from";
import { useForgeHostMap } from "../../lib/useForgeHostMap";
import { useModal } from "../../lib/useModal";
import { FORGE_UNASKED_CODES, useCloneSearch } from "./useCloneSearch";
import { SshHostTrustPanel, sshTrustTone } from "./SshHostTrustPanel";
import { RepoIdentityChips } from "./RepoIdentityMarks";
import { CloseGlyph } from "../../lib/CloseGlyph";

const PROTOCOL_IDS = ["ssh", "https", "cli"] as const;

function CloneIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function destinationMeta(destination: CloneDestination): string {
  if (destination.lastUsedAt !== undefined) return "recent";
  if (destination.relativePath === "") return "registered root";
  return `${destination.repoCount} ${
    destination.repoCount === 1 ? "repo" : "repos"
  }`;
}

function checkoutPath(
  destination: CloneDestination,
  repository: CloneRepository
): string {
  return joinDisplayPath(destination.path, repository.name);
}

function protocolLabel(protocol: CloneProtocol, host: ForgeHost): string {
  if (protocol === "ssh") return "SSH";
  if (protocol === "https") return "HTTPS";
  return cliProtocolLabel(host).label;
}

function protocolDetail(
  protocol: CloneProtocol,
  repository: CloneRepository | null,
  host: ForgeHost
): string {
  const hostname = repository?.hostname ?? defaultHostname(host);
  if (repository === null) {
    if (protocol === "ssh") return `git@${hostname}`;
    if (protocol === "https") return `https://${hostname}`;
    return cliProtocolLabel(host).detail("owner/name");
  }
  if (protocol === "ssh") return repository.sshUrl;
  if (protocol === "https") return repository.httpsUrl;
  return cliProtocolLabel(repository.host).detail(repository.nameWithOwner);
}

const CLONE_PROGRESS_LABELS: Record<CloneProgress["phase"], string> = {
  starting: "Preparing clone",
  counting: "Counting objects",
  compressing: "Compressing objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checking_out: "Checking out files",
  indexing: "Adding repository to PwrGit"
};

export function CloneRepoDialog({
  profile,
  onCloned,
  onReveal,
  onClose
}: {
  profile: Profile;
  onCloned: (repo: Repo) => void;
  /** Your fork is already checked out: the answer is that checkout, not a
   *  second clone of it. Same contract as `ForkRepoDialog`'s. */
  onReveal: (path: string) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  /** The card for one destination row. Named so the row's own `onMouseEnter`
   *  can call it rather than overwrite it — see the call site. */
  const destinationTip = (destination: CloneDestination) =>
    hoverTooltip(tip, destination.path);
  const [catalog, setCatalog] = useState<CloneCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<CloneDestination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [destinationsError, setDestinationsError] = useState<string | null>(
    null
  );
  const [sourceQuery, setSourceQuery] = useState("");
  const [selectedRepository, setSelectedRepository] =
    useState<CloneRepository | null>(null);
  const [checkedRepository, setCheckedRepository] =
    useState<CloneRepository | null>(null);
  const [sourceSelection, setSourceSelection] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<CloneProtocol>("ssh");
  const [host, setHost] = useState<ForgeKind>("github");
  const [destinationQuery, setDestinationQuery] = useState("");
  const [selectedDestination, setSelectedDestination] =
    useState<CloneDestination | null>(null);
  const [destinationSelectionPath, setDestinationSelectionPath] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  // Typed as the fork's progress, which is a superset: when "Clone from" is
  // your fork the same panel follows `repo:fork`, whose phases include every
  // clone phase plus the forge-side ones in front.
  const [cloneProgress, setCloneProgress] = useState<ForkProgress | null>(null);
  /** Which command the running operation is — the progress labels, the
   *  busy button and Cancel all depend on it. */
  const [operation, setOperation] = useState<"clone" | "fork">("clone");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [hostVerificationCommand, setHostVerificationCommand] = useState<string | null>(null);
  /** What the trust panel found, lifted so the whole card can carry the
   *  verdict: a key that matches the forge's published list must not keep
   *  wearing the red of the clone failure that exposed it. */
  const [hostVerification, setHostVerification] = useState<SshHostVerification | null>(null);
  const [commandCopied, setCommandCopied] = useState(false);
  const activeCloneIdRef = useRef<string | null>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const destinationInputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  // Escape, the focus trap, and handing focus back to whatever opened this —
  // the contract ForkCheckoutDialog already had. It refuses while a clone is
  // running, the same answer the backdrop gives. Without it Tab walked off the
  // footer into the window behind the dialog (SC 2.4.3), and Escape worked only
  // from the two search fields, each of which called onClose itself.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!busy) onClose();
    },
    initialFocusRef: sourceInputRef
  });

  useEffect(() => {
    let active = true;
    void dispatch("repo:cloneCatalog", { profileId: profile.id }).then(
      (result) => {
        if (!active) return;
        if (result.ok) setCatalog(result.value);
        else setCatalogError(result.error.message);
      }
    );
    return () => {
      active = false;
    };
  }, [profile.id]);

  // "Copied" acknowledges a click; it is not a state the button rests in.
  useEffect(() => {
    if (!commandCopied) return;
    const timer = setTimeout(() => setCommandCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [commandCopied]);

  useEffect(
    () =>
      subscribe("repo:cloneProgress", (event) => {
        if (
          event.profileId === profile.id &&
          event.operationId === activeCloneIdRef.current
        ) {
          setCloneProgress(event.progress);
        }
      }),
    [profile.id]
  );
  useEffect(
    () =>
      subscribe("repo:forkProgress", (event) => {
        if (
          event.profileId === profile.id &&
          event.operationId === activeCloneIdRef.current
        ) {
          setCloneProgress(event.progress);
        }
      }),
    [profile.id]
  );

  useEffect(() => {
    let active = true;
    let expansionFrame: number | null = null;
    setDestinations([]);
    setDestinationsLoading(true);
    setDestinationsError(null);

    const loadExpanded = (): void => {
      void dispatch("repo:cloneDestinations", {
        profileId: profile.id,
        includeNested: true
      }).then((result) => {
        if (!active) return;
        setDestinationsLoading(false);
        if (result.ok) {
          setDestinations(result.value);
          setDestinationsError(null);
        } else {
          setDestinationsError(result.error.message);
        }
      });
    };

    void dispatch("repo:cloneDestinations", {
      profileId: profile.id,
      includeNested: false
    }).then((result) => {
      if (!active) return;
      if (result.ok) setDestinations(result.value);
      else setDestinationsError(result.error.message);

      // Let the priority results paint before the broader prefix scan begins.
      expansionFrame = window.requestAnimationFrame(loadExpanded);
    });

    return () => {
      active = false;
      if (expansionFrame !== null) {
        window.cancelAnimationFrame(expansionFrame);
      }
    };
  }, [profile.id]);

  // Which forge runs at a pasted URL's host. Only main knows — the list is
  // what `gh`/`glab` are signed in to plus what the user added in Settings —
  // so without it a self-managed instance reads as `other` and the dialog
  // falls back to SSH/HTTPS instead of asking its CLI.
  const forgeHosts = useForgeHostMap();
  // The row the user picked, remembered as an instance. `chooseRepository`
  // rewrites the query to the bare slug, and a slug carries no host — so
  // `exactRepository` has to assume the forge's SaaS one. Re-confirming an
  // Enterprise repository against github.com/gitlab.com is a wrong answer, not
  // just a wasted round trip, so the pick is what the slug resolves to.
  const [picked, setPicked] = useState<ExactRepository | null>(null);
  const exactRepo = useMemo(() => {
    const parsed = exactRepository(sourceQuery, host, forgeHosts);
    if (
      parsed !== null &&
      picked !== null &&
      picked.host === parsed.host &&
      picked.nameWithOwner === parsed.nameWithOwner
    ) {
      return picked;
    }
    return parsed;
  }, [sourceQuery, host, forgeHosts, picked]);
  // The three strings that ARE an `ExactRepository`, pulled out so the check
  // effect can depend on values rather than on the memo's object identity —
  // which changes on every keystroke.
  const exactNameWithOwner = exactRepo?.nameWithOwner ?? null;
  const exactHostname = exactRepo?.hostname ?? null;
  const exactHost = exactRepo?.host ?? null;
  const localSourcePath = useMemo(
    () => localRepositoryPath(sourceQuery),
    [sourceQuery]
  );

  // The host toggle only offers forges whose CLI can actually answer; a
  // toggle that leads straight to "install the CLI" is a dead end dressed up
  // as a choice.
  const usableHosts = (catalog?.forges ?? [])
    .filter((status) => status.capabilities.repositoryApi !== false && forgeCanAnswerAnywhere(status))
    .map((status) => status.kind);
  // Snap onto a forge that can actually answer. Without this a machine with
  // only GitLab signed in leaves `host` on its "github" default forever: the
  // search is disabled, and the toggle that would fix it is not rendered
  // because there is only one usable host to offer.
  useEffect(() => {
    if (usableHosts.length > 0 && !usableHosts.includes(host)) {
      setHost(usableHosts[0]!);
    }
  }, [usableHosts.join(","), host]);

  const localSelected = selectedRepository?.localPath !== undefined;
  const activeHost = localSelected ? host : (selectedRepository?.host ?? host);
  // The instance the CLI would actually be pointed at. Asking about the SaaS
  // host instead greyed out `gh repo clone` for a user signed in only to their
  // company's Enterprise instance — the exact case the hostname plumbing
  // exists to serve.
  const activeHostname = localSelected
    ? undefined
    : (selectedRepository?.hostname ??
      exactHostname ??
      (activeHost === "other" ? undefined : defaultHostname(activeHost)));
  const forgeStatus = statusFor(catalog?.forges ?? [], activeHost);
  const cliDisabled =
    catalog !== null && !forgeCanAnswerDialog(forgeStatus, activeHostname);

  const gitOnly = forgeProductFor(activeHost)?.authentication === "repo-token";
  useEffect(() => { if (gitOnly) setProtocol("https"); }, [gitOnly]);

  // ── Clone from: the original, or your fork ──────────────────────────────
  // Asked only once a forge repository is picked, never per keystroke: the
  // accounts a fork could land in (one forge call per instance), then one
  // `repo:forkPreflight` for the default account. Drawn in
  // design/Fork While Cloning - UX Review.dc.html, turns 2a and 3.
  const forgeSource =
    selectedRepository !== null &&
    selectedRepository.localPath === undefined &&
    isForgeKind(selectedRepository.host) &&
    forgeProductFor(selectedRepository.host)?.capabilities.repositoryApi !== false
      ? selectedRepository
      : null;
  const forkOwnersHost: ForgeKind | null =
    forgeSource !== null && isForgeKind(forgeSource.host) ? forgeSource.host : null;
  const forkOwnersHostname = forgeSource?.hostname ?? null;
  /** Accounts per forge instance, kept for the dialog's life. Editing the
   *  query deselects the source, and keying a fetch on the selection spent a
   *  fresh `gh` lookup on every re-pick of a repository on the same host. */
  const [ownersByInstance, setOwnersByInstance] = useState<
    Record<string, ForgeOwner[] | "failed">
  >({});
  const ownersKey =
    forkOwnersHost === null ? null : `${forkOwnersHost}|${forkOwnersHostname ?? ""}`;
  const ownersAnswer = ownersKey === null ? undefined : ownersByInstance[ownersKey];
  /** Null while loading — the pair waits for it, so it is drawn once rather
   *  than appearing and then vanishing for a repository the user owns. */
  const forkOwners: ForgeOwner[] | null =
    ownersAnswer === undefined ? null : ownersAnswer === "failed" ? [] : ownersAnswer;
  const [forkTargetPick, setForkTargetPick] = useState<ForgeOwner | null>(null);
  const [forkPreflight, setForkPreflight] = useState<ForkPreflight | null>(null);
  const [forkCheckError, setForkCheckError] = useState<string | null>(null);
  /** The user's own choice; null follows `cloneFromDefault`. */
  const [cloneFromPick, setCloneFromPick] = useState<CloneFrom | null>(null);

  const ownersKnown = ownersAnswer !== undefined;
  useEffect(() => {
    if (forkOwnersHost === null || ownersKey === null || ownersKnown) {
      return undefined;
    }
    let active = true;
    void dispatch("repo:forkTargets", {
      host: forkOwnersHost,
      ...(forkOwnersHostname === null ? {} : { hostname: forkOwnersHostname })
    }).then((result) => {
      if (!active) return;
      setOwnersByInstance((current) => ({
        ...current,
        [ownersKey]: result.ok ? result.value : "failed"
      }));
    });
    return () => {
      active = false;
    };
  }, [ownersKey, ownersKnown]);

  const forkTargetList = useMemo(
    () => (forkOwners === null ? null : forkTargets(forkOwners, forgeSource)),
    [forkOwners, forgeSource]
  );
  const forkTarget =
    forkTargetList === null
      ? null
      : forkTargetPick !== null &&
          forkTargetList.some((owner) => owner.login === forkTargetPick.login)
        ? forkTargetPick
        : defaultForkTarget(forkTargetList);
  // A failed lookup leaves nothing to fork into AND nothing to tell whether
  // the repository is the user's own, so the pair would only ever offer a
  // dead card — on their own repositories too. It stays away instead.
  const offerPair =
    ownersAnswer !== "failed" &&
    offersCloneFrom({
      source: forgeSource,
      owners: forkOwners,
      preflight: forkPreflight
    });

  // Keyed on strings, for the reason ForkRepoDialog's preflight is: the
  // source object is replaced by every pick, the slug it names is not.
  const forkSourceKey =
    forgeSource === null
      ? null
      : `${forgeSource.host}|${forgeSource.hostname}|${forgeSource.nameWithOwner}`;
  const forkTargetLogin = forkTarget?.login ?? null;
  const forkOwnersLoaded = forkOwners !== null;
  useEffect(() => {
    setForkPreflight(null);
    setForkCheckError(null);
    // No account to fork into is answered without asking the forge.
    if (forgeSource === null || !forkOwnersLoaded || forkTargetLogin === null) {
      return undefined;
    }
    let active = true;
    void dispatch("repo:forkPreflight", {
      profileId: profile.id,
      source: forgeSource.nameWithOwner,
      host: forgeSource.host,
      hostname: forgeSource.hostname,
      targetOwner: forkTargetLogin
    }).then((result) => {
      if (!active) return;
      if (result.ok) setForkPreflight(result.value);
      else setForkCheckError(result.error.message);
    });
    return () => {
      active = false;
    };
  }, [forkSourceKey, forkTargetLogin, forkOwnersLoaded, profile.id]);

  const forkCard = forkCardState({
    preflight: forkPreflight,
    checkError: forkCheckError,
    targets: forkTargetList,
    cliLabel: cliProtocolLabel(forgeSource?.host ?? host).label
  });
  const originalCanPush =
    selectedRepository === null
      ? undefined
      : canPushOriginal(selectedRepository, forkPreflight);
  // An explicit pick is honoured even when the fork turns out to be
  // unavailable: the card says why and the button stays disabled, rather than
  // quietly relabelling itself to clone the original the user just declined.
  const cloneFrom: CloneFrom = !offerPair
    ? "original"
    : (cloneFromPick ??
      (forkCard.kind === "unavailable"
        ? "original"
        : cloneFromDefault(originalCanPush, forkCard)));
  const forking = cloneFrom === "fork";
  const forkStep = forkAction(forkPreflight);
  const forkUpstream = defaultUpstream(forkPreflight);
  /** What `origin` will be: the picked repository, or the fork. Null while
   *  the fork's name is still being looked up. Every surface that names the
   *  new checkout reads this — the protocol cards, "Will create", and the
   *  SSH recovery card — so none of them describes the wrong repository. */
  const originRepository: CloneRepository | null = forking
    ? forkPreflight === null
      ? null
      : forkOriginRepository(forkPreflight)
    : selectedRepository;
  /** Your fork is already on disk: nothing is cloned, so the clone sections
   *  step aside and the button reveals it. */
  const revealing = forking && forkStep.kind === "reveal_existing";
  // Picking a source moves focus to the destination field, and the forge's
  // answer can then remove that field. Hand focus to the button that now does
  // the work rather than letting it fall to <body>.
  useEffect(() => {
    if (!revealing) return;
    const active = document.activeElement;
    if (active === null || active === document.body) submitRef.current?.focus();
  }, [revealing]);

  // Nothing is asked of the forge until the box settles — and never on open.
  // The catalog this replaced listed every known owner's repositories up
  // front, which is one CLI round trip per account before the first paint.
  const search = useCloneSearch({
    profileId: profile.id,
    query: sourceQuery,
    host,
    enabled: usableHosts.includes(host) && localSourcePath === null && forgeProductFor(exactHost ?? undefined)?.capabilities.repositoryApi !== false
  });

  useEffect(() => setSourceSelection(0), [sourceQuery]);

  useEffect(() => {
    setCheckedRepository(null);
    setCheckError(null);
    if (exactNameWithOwner === null && localSourcePath === null) {
      setChecking(false);
      return;
    }

    setChecking(true);
    let active = true;
    const timeout = window.setTimeout(() => {
      const checked =
        localSourcePath === null
          ? dispatch("repo:checkCloneSource", {
              profileId: profile.id,
              nameWithOwner: exactNameWithOwner!,
              // Non-null for the same reason `exactNameWithOwner` is: this
              // branch is only reached when `exactRepo` parsed.
              host: exactHost!,
              // The instance, not just the forge. Sending only the kind had
              // main answer from github.com/gitlab.com, so a self-managed
              // project was confirmed — and then cloned — as whatever repo
              // shares its slug on the SaaS instance.
              ...(exactHostname === null ? {} : { hostname: exactHostname })
            })
          : dispatch("repo:checkLocalCloneSource", {
              profileId: profile.id,
              path: localSourcePath
            });
      void checked.then((result) => {
        if (!active) return;
        setChecking(false);
        if (result.ok) setCheckedRepository(result.value);
        else if (FORGE_UNASKED_CODES.has(result.error.code)) {
          // Built from the already-parsed `ExactRepository`, never re-parsed
          // from the query: `chooseRepository` rewrites `sourceQuery` to the
          // bare slug, and a slug has lost which instance it came from — a
          // re-parse would hand back clone URLs pointing at the SaaS host.
          setCheckedRepository(unverifiedCloneRepository(exactRepo));
        } else {
          setCheckError(result.error.message);
        }
      });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
    // Keyed on what the request actually carries. `sourceQuery` is
    // deliberately NOT a dependency: it changes for edits that resolve to the
    // same repository (a trailing space, a `.git` suffix) and again when
    // `chooseRepository` rewrites it, each costing a redundant CLI round trip.
    // `host` is NOT a dependency: it is only read through `exactHost`, which
    // already moves with it. Keeping it re-dispatched an identical
    // `repo:checkLocalCloneSource` and blanked a confirmed local row every
    // time the forge toggle moved.
  }, [exactNameWithOwner, exactHost, exactHostname, localSourcePath, profile.id]);

  const sourceResults = useMemo(() => {
    // Filtered to the picked forge: a host switch keeps the previous results
    // on screen through the debounce and round trip, and without this the
    // GitLab tab spends that second listing GitHub repositories.
    const ranked = rankCloneRepositories(
      search.repositories.filter((repository) => repository.host === host),
      sourceQuery
    );
    const rows = checkedRepository ? [checkedRepository, ...ranked] : ranked;
    return rows.filter(
      (repository, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.nameWithOwner.toLowerCase() ===
            repository.nameWithOwner.toLowerCase()
        ) === index
    );
  }, [search.repositories, host, sourceQuery, checkedRepository]);

  // One line for every reason the list is empty, so the states cannot
  // contradict each other. `checkError` wins over a bare "no matches": when
  // the box holds an exact slug, why THAT lookup failed is the useful answer.
  const emptyMessage =
    checkError ??
    sourceEmptyMessage({
      catalogLoaded: catalog !== null,
      catalogError,
      status: forgeStatus,
      cliLabel: cliProtocolLabel(activeHost).label,
      query: sourceQuery,
      searching: search.searching,
      searchError: search.error,
      owners: (catalog?.owners ?? [])
        .filter((owner) => owner.host === host)
        .map((owner) => owner.login)
    });

  const destinationResults = useMemo(
    () => filterCloneDestinations(destinations, destinationQuery),
    [destinations, destinationQuery]
  );
  const destinationSelection = cloneDestinationSelectionIndex(
    destinationResults,
    destinationSelectionPath
  );

  useEffect(() => setDestinationSelectionPath(null), [destinationQuery]);

  /** One reset for the whole failure card. The SSH recovery affordances hang
   *  off `submitError`, so clearing the message alone would leave a stale
   *  terminal command and a stale verdict behind the next one. */
  const clearSubmitError = (): void => {
    setSubmitError(null);
    setHostVerificationCommand(null);
    setHostVerification(null);
  };

  const chooseRepository = (repository: CloneRepository): void => {
    setSelectedRepository(repository);
    setCloneFromPick(null);
    setPicked({
      host: repository.host,
      hostname: repository.hostname,
      nameWithOwner: repository.nameWithOwner
    });
    setSourceQuery(forgeProductFor(repository.host)?.authentication === "repo-token"
      ? repository.httpsUrl : repository.nameWithOwner);
    clearSubmitError();
    window.requestAnimationFrame(() => destinationInputRef.current?.focus());
  };

  const activeDestination =
    selectedDestination ?? destinationResults[destinationSelection] ?? null;

  const submit = async (destination = activeDestination): Promise<void> => {
    if (selectedRepository === null || busy) return;
    if (revealing && forkStep.kind === "reveal_existing") {
      onReveal(forkStep.path);
      return;
    }
    if (destination === null || originRepository === null) return;
    if (
      forking &&
      (forkPreflight === null || forkTarget === null || forkStep.kind === "blocked")
    ) {
      return;
    }
    const operationId = window.crypto.randomUUID();
    activeCloneIdRef.current = operationId;
    setOperation(forking ? "fork" : "clone");
    setBusy(true);
    setCanceling(false);
    setCloneProgress({ phase: "starting", percent: null });
    clearSubmitError();
    const result =
      forking && forkPreflight !== null && forkTarget !== null
        ? await dispatch("repo:fork", {
            operationId,
            profileId: profile.id,
            source: selectedRepository.nameWithOwner,
            host: selectedRepository.host,
            hostname: selectedRepository.hostname,
            targetOwner: forkTarget.login,
            targetOwnerKind: forkTarget.kind,
            // Whatever preflight answered about — the existing fork, or the
            // name the service will create — never re-derived here.
            targetName: forkPreflight.target.name,
            protocol,
            parentPath: destination.path,
            defaultBranchOnly: false,
            upstream: forkUpstream
          })
        : await dispatch("repo:clone", {
            operationId,
            profileId: profile.id,
            nameWithOwner: selectedRepository.nameWithOwner,
            ...(selectedRepository.localPath === undefined
              ? {}
              : { sourcePath: selectedRepository.localPath }),
            protocol,
            parentPath: destination.path,
            host: selectedRepository.host,
            hostname: selectedRepository.hostname
          });
    activeCloneIdRef.current = null;
    setBusy(false);
    setCanceling(false);
    if (result.ok) onCloned(result.value);
    else {
      setCloneProgress(null);
      setSubmitError(result.error.message);
      setCommandCopied(false);
      setHostVerificationCommand(protocol === "ssh"
        ? sshHostVerificationCommand(result.error.message, originRepository.sshUrl)
        : null);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!busy) {
      onClose();
      return;
    }
    const operationId = activeCloneIdRef.current;
    if (operationId === null || canceling) return;
    setCanceling(true);
    if (operation === "fork") await dispatch("repo:cancelFork", { operationId });
    else await dispatch("repo:cancelClone", { operationId });
  };

  const progressLabel = (phase: ForkProgress["phase"]): string =>
    operation === "fork"
      ? FORK_PROGRESS_LABELS[phase]
      : CLONE_PROGRESS_LABELS[phase as CloneProgress["phase"]];
  const submitDisabled =
    busy ||
    selectedRepository === null ||
    (revealing
      ? false
      : activeDestination === null ||
        originRepository === null ||
        (forking && (forkTarget === null || forkStep.kind === "blocked")));
  const submitLabel = busy
    ? operation === "fork"
      ? `${FORK_PROGRESS_LABELS[cloneProgress?.phase ?? "starting"]}${
          typeof cloneProgress?.percent === "number"
            ? ` ${cloneProgress.percent}%`
            : ""
        }…`
      : typeof cloneProgress?.percent === "number"
        ? `Cloning ${cloneProgress.percent}%…`
        : "Cloning…"
    : forking
      ? forkStep.label
      : "Clone repository";

  return (
    <div
      className="overlay-backdrop clone-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="overlay-panel clone-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Clone a repository"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="clone-dialog__title">
          <span className="clone-dialog__icon">
            <CloneIcon />
          </span>
          <span>
            <strong>Clone a repository</strong>
            <small>
              Find GitHub repos from owners already used in {profile.name}
            </small>
          </span>
          <button
            type="button"
            className="clone-dialog__close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <CloseGlyph />
          </button>
        </div>

        <div className="clone-dialog__body">
          <section className="clone-section">
            <label className="clone-label" htmlFor="clone-source">
              Repository
              {catalog !== null && catalog.owners.length > 0 && (
                <span className="clone-label__hint">
                  {catalog.owners.map((owner) => owner.login).join(" · ")}
                </span>
              )}
              {usableHosts.length > 1 && (
                <span className="fork-hosts" role="group" aria-label="Forge">
                  {usableHosts.map((candidate) => (
                    <button
                      type="button"
                      key={candidate}
                      className={`fork-host${host === candidate ? " is-active" : ""}`}
                      aria-pressed={host === candidate}
                      disabled={busy}
                      onClick={() => setHost(candidate)}
                    >
                      {forgeLabel(candidate)}
                    </button>
                  ))}
                </span>
              )}
            </label>
            <div className="clone-input-wrap">
              <CloneIcon />
              <input
                id="clone-source"
                ref={sourceInputRef}
                value={sourceQuery}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="Search, enter owner/name, or paste a local path…"
                onChange={(event) => {
                  setSourceQuery(event.target.value);
                  setSelectedRepository(null);
                  clearSubmitError();
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSourceSelection((selection) =>
                      moveCloneSelection(selection, 1, sourceResults.length)
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSourceSelection((selection) =>
                      moveCloneSelection(selection, -1, sourceResults.length)
                    );
                  } else if (event.key === "Enter") {
                    const repository = cloneRepositoryAtSelection(
                      sourceResults,
                      sourceSelection
                    );
                    if (repository !== undefined) {
                      event.preventDefault();
                      chooseRepository(repository);
                    }
                  } else if (event.key === "Tab" && !event.shiftKey) {
                    const repository =
                      selectedRepository ??
                      cloneRepositoryAtSelection(
                        sourceResults,
                        sourceSelection
                      );
                    if (repository !== undefined) {
                      event.preventDefault();
                      chooseRepository(repository);
                    }
                  }
                }}
              />
              {(checking || search.searching) && (
                <span className="clone-input-status">
                  {checking ? "checking…" : "searching…"}
                </span>
              )}
            </div>

            <div className="clone-source-results" role="listbox">
              {sourceResults.map((repository, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === sourceSelection}
                  key={repository.localPath ?? repository.nameWithOwner}
                  className={`clone-source-row${
                    index === sourceSelection ? " is-selected" : ""
                  }${
                    selectedRepository?.nameWithOwner === repository.nameWithOwner
                      ? " is-picked"
                      : ""
                  }`}
                  disabled={busy}
                  onMouseEnter={() => setSourceSelection(index)}
                  onClick={() => chooseRepository(repository)}
                >
                  <span className="clone-source-row__mark" />
                  <span className="clone-source-row__copy">
                    <strong>{repository.localPath ?? repository.nameWithOwner}</strong>
                    <small>{repository.description ?? "Forge repository"}</small>
                  </span>
                  {repository.localPath === undefined && (
                    <RepoIdentityChips repository={repository} />
                  )}
                  {repository.localPaths.length > 0 && (
                    <span
                      className="clone-chip clone-chip--muted"
                      {...hoverTooltip(tip, repository.localPaths.join("\n"))}
                    >
                      cloned
                    </span>
                  )}
                </button>
              ))}
              {sourceResults.length === 0 && !checking && emptyMessage !== null && (
                <div
                  className={`clone-empty${
                    catalogError ?? checkError ?? search.error
                      ? " clone-empty--error"
                      : ""
                  }`}
                >
                  {emptyMessage}
                </div>
              )}
            </div>
          </section>

          {offerPair && selectedRepository !== null && (
            <section className="clone-section">
              <div className="clone-label" id="clone-from-label">
                Clone from
                <span className="clone-label__hint">
                  origin is the one you pick
                </span>
              </div>
              {/* Two cards that show both answers, the way the protocol cards
                  below do — never one toggle that swaps its own label. */}
              <div
                className="clone-from"
                role="group"
                aria-labelledby="clone-from-label"
              >
                <button
                  type="button"
                  className={`clone-from__card${forking ? "" : " is-active"}`}
                  aria-pressed={!forking}
                  disabled={busy}
                  onClick={() => {
                    setCloneFromPick("original");
                    clearSubmitError();
                  }}
                >
                  <span className="clone-from__top">
                    <span className="clone-from__radio" aria-hidden="true" />
                    <strong>The original</strong>
                    {originalCanPush === false && (
                      <span className="clone-chip clone-chip--nopush">read-only</span>
                    )}
                    {originalCanPush === true && (
                      <span className="clone-chip clone-chip--muted">can push</span>
                    )}
                  </span>
                  <code className="clone-from__slug">
                    {selectedRepository.nameWithOwner}
                  </code>
                  <small>{originalCardDetail(originalCanPush)}</small>
                </button>
                <button
                  type="button"
                  className={`clone-from__card${forking ? " is-active" : ""}`}
                  aria-pressed={forking}
                  disabled={busy || forkCard.kind === "unavailable"}
                  onClick={() => {
                    setCloneFromPick("fork");
                    clearSubmitError();
                  }}
                >
                  <span className="clone-from__top">
                    <span className="clone-from__radio" aria-hidden="true" />
                    <strong>Your fork</strong>
                    {(() => {
                      const pill = forkCardPill(forkCard, selectedRepository.host);
                      return (
                        <span
                          className={
                            pill.tone === "accent"
                              ? "clone-chip"
                              : `clone-chip clone-chip--${pill.tone}`
                          }
                        >
                          {pill.label}
                        </span>
                      );
                    })()}
                  </span>
                  <code className="clone-from__slug">
                    {forkPreflight?.target.nameWithOwner ??
                      `${forkTarget?.login ?? "you"}/${selectedRepository.name}`}
                  </code>
                  <small>
                    {forkCardDetail(forkCard, selectedRepository.host, forkUpstream)}
                  </small>
                </button>
              </div>
              {/* Only where there is a choice to make, and only once it is the
                  fork being cloned. Renaming stays in Fork…, where the name
                  field and its collision check live. */}
              {forking && forkTargetList !== null && forkTargetList.length > 1 && (
                <div className="clone-from__into">
                  <span id="clone-fork-into">Fork into</span>
                  <span
                    className="fork-hosts"
                    role="group"
                    aria-labelledby="clone-fork-into"
                  >
                    {forkTargetList.map((owner) => (
                      <button
                        type="button"
                        key={owner.login}
                        className={`fork-host${
                          forkTarget?.login === owner.login ? " is-active" : ""
                        }`}
                        aria-pressed={forkTarget?.login === owner.login}
                        disabled={busy}
                        {...hoverTooltip(tip, ownerKindLabel(owner))}
                        onClick={() => setForkTargetPick(owner)}
                      >
                        {owner.login}
                      </button>
                    ))}
                  </span>
                </div>
              )}
            </section>
          )}

          {!revealing && (
            <section className="clone-section">
              <div className="clone-label">Clone with</div>
              <div className="clone-protocols">
                {localSelected ? (
                  <button
                    type="button"
                    disabled
                    className="clone-protocol is-active"
                  >
                    <strong>Local path</strong>
                    <small>git clone</small>
                  </button>
                ) : PROTOCOL_IDS.filter((candidate) => !gitOnly || candidate === "https").map((candidate) => {
                  const disabled = candidate === "cli" && cliDisabled;
                  const detail = protocolDetail(
                    candidate,
                    originRepository,
                    activeHost
                  );
                  const label = protocolLabel(candidate, activeHost);
                  return (
                    <button
                      type="button"
                      key={candidate}
                      disabled={busy || disabled}
                      className={`clone-protocol${
                        protocol === candidate ? " is-active" : ""
                      }`}
                      /* The unavailable reason goes in the NAME as well as the
                         card: a disabled button still announces its name, and AT
                         reads that over any card. The enabled case carries
                         `detail`, which `.clone-protocol small` ellipsises. */
                      aria-label={
                        disabled
                          ? `${label} — unavailable, ${label} must be installed and signed in`
                          : undefined
                      }
                      {...hoverTooltip(
                        tip,
                        disabled ? `${label} must be installed and signed in` : detail
                      )}
                      onClick={() => { setProtocol(candidate); clearSubmitError(); }}
                    >
                      <strong>{label}</strong>
                      <small>{detail}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {!revealing && (
            <section className="clone-section">
              <label className="clone-label" htmlFor="clone-destination">
                Check out to
                <span className="clone-label__hint">
                  inside a registered repo folder
                </span>
              </label>
              <div className="clone-input-wrap">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7h6l2 2h10v10H3z" />
                </svg>
                <input
                  id="clone-destination"
                  ref={destinationInputRef}
                  value={destinationQuery}
                  aria-describedby={
                    activeDestination === null || originRepository === null
                      ? undefined
                      : "clone-destination-choice"
                  }
                  disabled={busy || selectedRepository === null}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Type to find a root or nested prefix…"
                  onChange={(event) => {
                    setDestinationQuery(event.target.value);
                    setSelectedDestination(null);
                    clearSubmitError();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      const selection = moveCloneSelection(
                        destinationSelection,
                        1,
                        destinationResults.length
                      );
                      setDestinationSelectionPath(
                        destinationResults[selection]?.path ?? null
                      );
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      const selection = moveCloneSelection(
                        destinationSelection,
                        -1,
                        destinationResults.length
                      );
                      setDestinationSelectionPath(
                        destinationResults[selection]?.path ?? null
                      );
                    } else if (event.key === "Enter") {
                      const destination =
                        selectedDestination ??
                        destinationResults[destinationSelection];
                      if (destination !== undefined) {
                        event.preventDefault();
                        void submit(destination);
                      }
                    }
                  }}
                />
                {destinationsLoading && (
                  <span className="clone-input-status">finding folders…</span>
                )}
              </div>

              <div className="clone-destination-results" role="listbox">
                {destinationResults.map((destination, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === destinationSelection}
                    key={destination.path}
                    className={`clone-destination-row${
                      index === destinationSelection ? " is-selected" : ""
                    }${
                      selectedDestination?.path === destination.path
                        ? " is-picked"
                        : ""
                    }`}
                    disabled={busy || selectedRepository === null}
                    /* The full path as the option's NAME, where the row's own
                       text is a `root/relative/` label whose basename repeats
                       across registered roots. That ambiguity was why the path
                       was sitting in a `title` — an attribute no screen reader
                       reads off a named button, and no keyboard user can open. */
                    aria-label={`${destination.path} — ${destinationMeta(destination)}`}
                    {...destinationTip(destination)}
                    // The row already moves the selection on enter, so the
                    // card's own handler is called rather than spread over it —
                    // a later `onMouseEnter` would silently win.
                    onMouseEnter={(event) => {
                      setDestinationSelectionPath(destination.path);
                      tip.show(event.currentTarget, destination.path);
                    }}
                    onClick={() => {
                      setSelectedDestination(destination);
                      setDestinationQuery(cloneDestinationLabel(destination));
                    }}
                  >
                    <span className="clone-destination-row__path">
                      {cloneDestinationLabel(destination)}
                    </span>
                    <span className="clone-destination-row__meta">
                      {destinationMeta(destination)}
                    </span>
                  </button>
                ))}
                {destinationsError !== null && destinations.length === 0 && (
                  <div className="clone-empty clone-empty--error">
                    {destinationsError}
                  </div>
                )}
                {!destinationsLoading &&
                  destinationsError === null &&
                  destinations.length === 0 && (
                    <div className="clone-empty">
                      Add a repo folder to this profile before cloning.
                    </div>
                  )}
                {!destinationsLoading &&
                  destinations.length > 0 &&
                  destinationResults.length === 0 && (
                    <div className="clone-empty">
                      No checkout folders match “{destinationQuery}”.
                    </div>
                )}
                {destinationsLoading && (
                  <div className="clone-destination-progress" role="status">
                    <span className="clone-destination-progress__dot" />
                    Finding more checkout folders…
                  </div>
                )}
              </div>
              {activeDestination !== null && originRepository !== null && (
                <div
                  id="clone-destination-choice"
                  className="clone-destination-choice"
                  role="status"
                  {...hoverTooltip(
                    tip,
                    checkoutPath(activeDestination, originRepository)
                  )}
                >
                  Will create{" "}
                  <strong>
                    {checkoutPath(activeDestination, originRepository)}
                  </strong>
                  {forking && forkUpstream !== null && (
                    <> · upstream {forkUpstream}</>
                  )}
                </div>
              )}
            </section>
          )}

          {submitError !== null && (
            hostVerificationCommand === null ? (
              <div className="clone-submit-error" role="alert">{submitError}</div>
            ) : (
              <div className={`clone-submit-error clone-submit-error--${
                hostVerification === null ? "danger" : sshTrustTone(hostVerification)
              }`}>
                {/* Only the headline is the alert. The panel below it is an
                    interactive region whose contents change as the user works
                    through it; inside a live region every one of those changes
                    would re-announce the whole card. */}
                <strong className="clone-submit-error__title" role="alert">
                  SSH could not verify the server’s identity.
                </strong>
                {selectedRepository !== null && selectedRepository.host !== "other" && <SshHostTrustPanel
                  key={selectedRepository.hostname}
                  kind={selectedRepository.host}
                  hostname={selectedRepository.hostname}
                  onTrusted={() => { void submit(); }}
                  onVerification={setHostVerification}
                />}
                {/* Folded, because it is the fallback. Left open it competes
                    with the in-app path for the same decision, and the user
                    reads four same-weight buttons instead of one next step. */}
                <details className="clone-submit-error__more">
                  <summary>Verify in a terminal instead</summary>
                  <p>Compare the fingerprint with one published by the host or supplied by its administrator before accepting it, then retry the clone. If the key has changed, verify why before replacing a saved key.</p>
                  <p className="clone-submit-error__command">
                    <code className="selectable">{hostVerificationCommand}</code>
                    <button type="button" className="ssh-trust__button ssh-trust__button--quiet" onClick={() => {
                      void copyText(hostVerificationCommand).then(() => setCommandCopied(true)).catch(() => setCommandCopied(false));
                    }}>{commandCopied ? "Copied" : "Copy command"}</button>
                  </p>
                  {!cliDisabled && !gitOnly && (
                    <p>
                      <button type="button" className="ssh-trust__button ssh-trust__button--quiet" onClick={() => {
                        setProtocol("cli");
                        clearSubmitError();
                      }}>Use {cliProtocolLabel(activeHost).label}</button>{" "}
                      Selects the CLI option; click Clone repository to retry. CLI login is separate from SSH trust, and some CLIs may still use SSH.
                    </p>
                  )}
                </details>
                <details className="clone-submit-error__more">
                  <summary>Git error</summary>
                  <p className="clone-submit-error__git selectable">{submitError}</p>
                </details>
              </div>
            )
          )}
        </div>

        {busy && cloneProgress !== null && (
          <div className="clone-progress" aria-live="polite">
            <div className="clone-progress__status">
              <strong>{progressLabel(cloneProgress.phase)}</strong>
              {cloneProgress.percent !== null && (
                <span>{cloneProgress.percent}%</span>
              )}
            </div>
            <div
              className={`clone-progress__track${
                cloneProgress.percent === null ? " is-indeterminate" : ""
              }`}
              role="progressbar"
              aria-label={progressLabel(cloneProgress.phase)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={cloneProgress.percent ?? undefined}
            >
              <span
                style={{
                  width:
                    cloneProgress.percent === null
                      ? undefined
                      : `${cloneProgress.percent}%`
                }}
              />
            </div>
            <div className="clone-progress__metrics">
              {cloneProgress.bytesReceived !== undefined && (
                <span>{cloneProgress.bytesReceived} transferred</span>
              )}
              {cloneProgress.bytesReceived === undefined &&
                cloneProgress.completedObjects !== undefined &&
                cloneProgress.totalObjects !== undefined && (
                  <span>
                    {cloneProgress.completedObjects.toLocaleString()} /{" "}
                    {cloneProgress.totalObjects.toLocaleString()} objects
                  </span>
                )}
              {cloneProgress.transferRate !== undefined && (
                <span>{cloneProgress.transferRate}</span>
              )}
            </div>
          </div>
        )}

        <div className="clone-dialog__foot">
          <span>↑↓ navigate</span>
          <span>tab next field</span>
          <span>↵ select / clone</span>
          <span className="clone-dialog__spacer" />
          <button
            type="button"
            className="modal__cancel"
            disabled={canceling || cloneProgress?.phase === "indexing"}
            onClick={() => void cancel()}
          >
            {canceling
              ? "Canceling…"
              : cloneProgress?.phase === "indexing"
                ? "Finishing…"
                : "Cancel"}
          </button>
          <button
            type="button"
            ref={submitRef}
            className="modal__create clone-dialog__submit"
            disabled={submitDisabled}
            onClick={() => void submit()}
          >
            {submitLabel}
          </button>
        </div>
      </div>
      {tip.tooltipNode}
    </div>
  );
}
