import { useEffect, useRef, useState } from "react";
import type { AgentEffort } from "@pwrgit/shared";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import {
  chosenModelLabel,
  clearAgentModel,
  loadAgentAvailability,
  loadAgentModels,
  setAgentChoice,
  setAgentEffort,
  useAgent
} from "./agent-store";

const EFFORTS: { value: AgentEffort | undefined; label: string }[] = [
  { value: undefined, label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

/**
 * The split pill in the rail header: which agent, which model, and a menu to
 * change either for this window. Availability is a dot; no agent is a dashed
 * pill, not a warning.
 */
export function AgentChip({
  lastModel,
  openSignal = 0
}: {
  /** The model the last response reported, shown until one is chosen. */
  lastModel?: string;
  /** Bump to open the menu from elsewhere (the "Draft with an agent…" link). */
  openSignal?: number;
}) {
  const agent = useAgent();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (): void => setOpen(false);
  useDismissable({ open, onDismiss: close, triggerRef: chipRef, surfaceRef: menuRef });
  useMenuNavigation({ open, menuRef, onClose: close });

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);
  useEffect(() => {
    if (open && agent.ready) loadAgentModels();
  }, [open, agent.ready]);

  const loading =
    agent.state.availability.kind === "loading" ||
    agent.state.availability.kind === "idle";
  const model = agent.ready ? chosenModelLabel(agent, lastModel) : null;
  const providers =
    agent.state.availability.kind === "ready"
      ? agent.state.availability.value.providers
      : [];
  const acp = providers.filter((provider) => provider.kind === "acp");
  const effort = agent.state.choice.effort;

  return (
    <div className="agent-chip-wrap">
      <button
        ref={chipRef}
        type="button"
        className={`agent-chip${open ? " is-open" : ""}${!agent.ready && !loading ? " agent-chip--none" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-chip__main">
          <span
            className={`agent-dot${loading ? " agent-dot--wait" : agent.ready ? "" : " agent-dot--off"}`}
            aria-hidden="true"
          />
          {loading ? "Agent…" : agent.ready ? agent.name : "No agent"}
          {model !== null && <i className="agent-chip__model">{model}</i>}
        </span>
        <span className="agent-chip__caret">
          <ChevronGlyph up={open} />
        </span>
      </button>

      {open && <div className="agent-menu__backdrop" onClick={close} />}
      {open && (
        <div
          ref={menuRef}
          className="agent-menu"
          role="menu"
          aria-label="History editing agent"
        >
          <div className="agent-menu__head" aria-hidden="true">
            History editing agent
          </div>
          {agent.ready ? (
            agent.state.models.kind === "ready" &&
            agent.state.models.value.length > 0 ? (
              agent.state.models.value.map((option) => {
                const on =
                  agent.state.choice.model === option.id ||
                  (agent.state.choice.model === undefined && option.isDefault);
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={`agent-menu__item${on ? " is-on" : ""}`}
                    onClick={() => {
                      if (option.isDefault) clearAgentModel();
                      else setAgentChoice({ model: option.id });
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
                    {agent.state.models.kind === "loading"
                      ? "Loading models…"
                      : agent.state.models.kind === "error"
                        ? "Default model. The model list did not load."
                        : "Default model"}
                  </small>
                </span>
              </div>
            )
          ) : (
            <div className="agent-menu__item agent-menu__item--static is-disabled">
              <span className="agent-menu__check" aria-hidden="true" />
              <span className="agent-dot agent-dot--off" aria-hidden="true" />
              <span className="agent-menu__name">
                Codex
                <small>
                  {agent.state.availability.kind === "error"
                    ? agent.state.availability.message
                    : (agent.codex?.detail ?? "Looking for a local Codex CLI…")}
                </small>
              </span>
            </div>
          )}
          {acp.map((provider) => (
            <div
              key={provider.id}
              className="agent-menu__item agent-menu__item--static is-disabled"
            >
              <span className="agent-menu__check" aria-hidden="true" />
              <span className="agent-dot agent-dot--off" aria-hidden="true" />
              <span className="agent-menu__name">
                {provider.displayName}
                <small>{provider.detail}</small>
              </span>
            </div>
          ))}
          {agent.ready && (
            <>
              <div className="agent-menu__sep" role="separator" />
              <div className="agent-menu__head" id="agent-menu-effort">
                Effort
              </div>
              <div className="agent-menu__seg" role="group" aria-labelledby="agent-menu-effort">
                {EFFORTS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effort === option.value}
                    className={effort === option.value ? "is-on" : ""}
                    onClick={() => setAgentEffort(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="agent-menu__sep" role="separator" />
          <div className="agent-menu__foot">
            {agent.ready
              ? "For requests from this window until PwrGit quits. The agent gets diffs as data, with no tools and no repository access."
              : "Install the Codex CLI and sign in; PwrGit finds it on its own. Squash and Reorder work without an agent."}
            {!agent.ready && (
              <button
                type="button"
                role="menuitem"
                className="agent-link"
                onClick={() => loadAgentAvailability(true)}
              >
                Check again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
