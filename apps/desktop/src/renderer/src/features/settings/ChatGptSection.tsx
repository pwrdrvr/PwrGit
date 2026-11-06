import { useId, useRef, useState } from "react";
import { useModal } from "../../lib/useModal";
import { dispatch } from "../../lib/pwrgit";
import { useAiProvidersContext } from "./AiProvidersContext";
import type { AiProviderStatus } from "./ai-provider-status";
import { SettingsField, SettingsSection } from "./SettingsLayout";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
export const CHATGPT_HELP_URL =
  "https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites";
export function ChatGptSection({ status }: { status: AiProviderStatus }) {
  const ai = useAiProvidersContext();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [welcome, setWelcome] = useState(false);
  const usingPlan =
    ai.chatGpt?.planUsage === true &&
    ai.settings?.enabled === true &&
    Object.values(ai.settings.jobs).some((job) => job.provider === "chatgpt");
  const act = async (signIn: boolean) => {
    if (ai.profileId === null) return;
    setBusy(true);
    setNotice("");
    try {
      if (signIn) {
        const result = await dispatch("aiProviders:chatGptSignIn", {
          profileId: ai.profileId,
        });
        if (result.ok) setWelcome(result.value.welcome);
        else setNotice(result.error.message);
      } else {
        const result = await dispatch("aiProviders:chatGptSignOut", {
          profileId: ai.profileId,
        });
        setWelcome(false);
        if (!result.ok) setNotice(result.error.message);
        else if (!result.value.remoteRevocationConfirmed)
          setNotice(
            "Local tokens cleared. Remote revocation was not confirmed; disconnect PwrGit in ChatGPT settings.",
          );
      }
      await ai.refreshChatGpt?.();
    } catch {
      setNotice("ChatGPT sign-in could not finish. Try again later.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      sectionId="chatgpt"
      title="Sign in with ChatGPT"
      description="PwrGit is free. The free app can use your ChatGPT plan for commit messages and history editing."
      chip={<span>{usingPlan ? "Using ChatGPT plan" : status.badge}</span>}
    >
      <SettingsField
        label="This profile"
        sub="Choose this provider under AI Features after connecting. AI stays off until you turn it on."
        help={ai.chatGpt?.label || "Tokens stay encrypted on this machine."}
        error={notice || undefined}
        control={
          <div className="settings-field__actions">
            <button
              className="settings-button"
              disabled={busy}
              type="button"
              onClick={() => void act(true)}
            >
              {busy ? "Waiting…" : "Continue with ChatGPT"}
            </button>
            {ai.chatGpt?.connected && (
              <button
                className="settings-button"
                disabled={busy}
                type="button"
                onClick={() => void act(false)}
              >
                Disconnect
              </button>
            )}
            <button
              className="settings-button"
              type="button"
              onClick={() =>
                void dispatch("shell:openExternal", { url: CHATGPT_USAGE_URL })
              }
            >
              Manage usage
            </button>
            <button
              className="settings-button"
              type="button"
              onClick={() =>
                void dispatch("shell:openExternal", { url: CHATGPT_HELP_URL })
              }
            >
              Learn more
            </button>
          </div>
        }
      />
      {welcome && <ChatGptWelcome onClose={() => setWelcome(false)} />}
    </SettingsSection>
  );
}

function ChatGptWelcome({ onClose }: { onClose: () => void }) {
  const title = useId();
  const gotIt = useRef<HTMLButtonElement | null>(null);
  const modal = useModal<HTMLDivElement>({ onClose, initialFocusRef: gotIt });
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        ref={modal}
        className="modal modal--dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id={title}>
          You’re using your ChatGPT plan
        </div>
        <p className="dialog__message">
          Eligible AI requests in PwrGit will use your ChatGPT plan. You can
          manage this app’s usage in ChatGPT settings. AI stays off until you
          turn it on for this profile.
        </p>
        <div className="modal__actions">
          <button
            className="modal__create"
            type="button"
            ref={gotIt}
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
