import { useEffect, useRef, useState } from "react";
import {
  AI_JOBS,
  AI_REASONING_EFFORTS,
  isAiReasoningEffort,
  type AgentChoice,
  type AiJobId,
  type CodexModelOption
} from "@pwrgit/shared";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import {
  chosenModelLabel,
  loadAgentAvailability,
  loadAgentModels,
  openAiSettings,
  useAgent
} from "./agent-store";

/** The efforts a model accepts, or Codex's usual three when it names none. */
function effortsFor(model: CodexModelOption | undefined): string[] {
  const advertised = model?.supportedReasoningEfforts.filter(isAiReasoningEffort) ?? [];
  return advertised.length > 0 ? advertised : [...AI_REASONING_EFFORTS];
}

function effortLabel(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * The split pill in the rail header: which agent and model a request runs on,
 * and a menu to change either for this request only. The default comes from
 * Settings → AI Features, and the menu says so. AI off is a dashed "AI off"
 * pill and an agent that cannot run is a dashed "No agent" — neither a warning.
 */
export function AgentChip({
  jobId,
  choice,
  onChoice,
  lastModel
}: {
  jobId: AiJobId;
  /** This request's override; `{}` runs the Settings default. */
  choice: AgentChoice;
  onChoice: (next: AgentChoice) => void;
  /** The model the last response reported, shown when Settings names none. */
  lastModel?: string;
}) {
  const agent = useAgent(jobId);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (): void => setOpen(false);
  useDismissable({ open, onDismiss: close, triggerRef: chipRef, surfaceRef: menuRef });
  useMenuNavigation({ open, menuRef, onClose: close });

  useEffect(() => {
    if (open && agent.ready) loadAgentModels();
  }, [open, agent.ready]);

  const models = agent.models.kind === "ready" ? agent.models.value : [];
  // The model a request with no override runs on: Settings', else Codex's own.
  const defaultId =
    agent.status?.model ?? models.find((model) => model.isDefault)?.id ?? null;
  const activeId = choice.model ?? defaultId;
  const activeModel = models.find((model) => model.id === activeId);
  const efforts = effortsFor(activeModel);
  const model = agent.ready ? chosenModelLabel(agent, choice, lastModel) : null;
  const label = agent.loading
    ? "Agent…"
    : agent.off
      ? "AI off"
      : agent.ready
        ? agent.name
        : "No agent";
  const title = `${AI_JOBS[jobId].label} agent`;
  const configuredEffort = agent.status?.effort ?? null;
  const defaultEffortTitle =
    configuredEffort === null ? "Each task's own" : `Settings: ${configuredEffort}`;

  const pickModel = (id: string): void => {
    const next: AgentChoice = {};
    if (id !== defaultId) next.model = id;
    // An effort the new model does not take would be refused in main anyway.
    const nextModel = models.find((option) => option.id === id);
    if (choice.effort !== undefined && effortsFor(nextModel).includes(choice.effort)) {
      next.effort = choice.effort;
    }
    onChoice(next);
  };
  const pickEffort = (effort: string | undefined): void => {
    const next: AgentChoice = {};
    if (choice.model !== undefined) next.model = choice.model;
    if (effort !== undefined) next.effort = effort;
    onChoice(next);
  };

  return (
    <div className="agent-chip-wrap">
      <button
        ref={chipRef}
        type="button"
        className={`agent-chip${open ? " is-open" : ""}${!agent.ready && !agent.loading ? " agent-chip--none" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-chip__main">
          <span
            className={`agent-dot${agent.loading ? " agent-dot--wait" : agent.ready ? "" : " agent-dot--off"}`}
            aria-hidden="true"
          />
          {label}
          {model !== null && <i className="agent-chip__model">{model}</i>}
        </span>
        <span className="agent-chip__caret">
          <ChevronGlyph up={open} />
        </span>
      </button>

      {open && <div className="agent-menu__backdrop" onClick={close} />}
      {open && (
        <div ref={menuRef} className="agent-menu" role="menu" aria-label={title}>
          <div className="agent-menu__head" aria-hidden="true">
            {title}
          </div>
          {agent.ready ? (
            models.length > 0 ? (
              models.map((option) => {
                const on = option.id === activeId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={`agent-menu__item${on ? " is-on" : ""}`}
                    onClick={() => {
                      pickModel(option.id);
                      close();
                    }}
                  >
                    <span className="agent-menu__check" aria-hidden="true">
                      {on ? "✓" : ""}
                    </span>
                    <span className="agent-dot" aria-hidden="true" />
                    <span className="agent-menu__name">{agent.name}</span>
                    <span className="agent-menu__model">{option.displayName}</span>
                  </button>
                );
              })
            ) : (
              <div className="agent-menu__item is-on agent-menu__item--static">
                <span className="agent-menu__check" aria-hidden="true">✓</span>
                <span className="agent-dot" aria-hidden="true" />
                <span className="agent-menu__name">
                  {agent.name}
                  <small>
                    {agent.models.kind === "loading"
                      ? "Loading models…"
                      : agent.models.kind === "error"
                        ? "The model list did not load, so this runs on the default."
                        : (agent.status?.modelLabel ?? "Default model")}
                  </small>
                </span>
              </div>
            )
          ) : (
            <div className="agent-menu__item agent-menu__item--static is-disabled">
              <span className="agent-menu__check" aria-hidden="true" />
              <span className="agent-dot agent-dot--off" aria-hidden="true" />
              <span className="agent-menu__name">
                {agent.off ? "AI features are off" : agent.name}
                <small>
                  {agent.loading
                    ? "Checking the AI provider settings…"
                    : agent.off
                      ? "Nothing is sent to an agent from this profile until they're turned on."
                      : (agent.reason ?? "")}
                </small>
              </span>
            </div>
          )}
          {agent.ready && (
            <>
              <div className="agent-menu__sep" role="separator" />
              <div className="agent-menu__head" id="agent-menu-effort">
                Effort
              </div>
              <div className="agent-menu__seg" role="group" aria-labelledby="agent-menu-effort">
                {[undefined, ...efforts].map((effort) => {
                  const on = choice.effort === effort;
                  return (
                    <button
                      key={effort ?? ""}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      className={on ? "is-on" : ""}
                      title={effort === undefined ? defaultEffortTitle : undefined}
                      onClick={() => pickEffort(effort)}
                    >
                      {effort === undefined ? "Default" : effortLabel(effort)}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div className="agent-menu__sep" role="separator" />
          <div className="agent-menu__foot">
            {agent.ready ? (
              <>
                Only this request. The default is in
                <button
                  type="button"
                  role="menuitem"
                  className="agent-link"
                  onClick={() => {
                    openAiSettings("ai-features", "default-agents");
                    close();
                  }}
                >
                  Settings › AI Features
                </button>
              </>
            ) : agent.off ? (
              <>
                Squash and Reorder work without an agent.
                <button
                  type="button"
                  role="menuitem"
                  className="agent-link"
                  onClick={() => {
                    openAiSettings("ai-features", "availability");
                    close();
                  }}
                >
                  Open AI Features
                </button>
              </>
            ) : (
              !agent.loading && (
                <>
                  Squash and Reorder work without an agent.
                  <button
                    type="button"
                    role="menuitem"
                    className="agent-link"
                    onClick={() => {
                      openAiSettings("ai-providers");
                      close();
                    }}
                  >
                    Open AI Providers
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="agent-link"
                    onClick={() => loadAgentAvailability({ refresh: true })}
                  >
                    Check again
                  </button>
                </>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
