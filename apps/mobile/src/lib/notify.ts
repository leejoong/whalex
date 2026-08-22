import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { t } from "../i18n";

/**
 * Local notifications for the moments worth pulling a phone out of a pocket:
 * a turn finished or failed, an approval is waiting, the agent asked
 * something. Local only — there is no relay server in this architecture, so
 * they fire for as long as Android keeps the app's process (and its socket)
 * alive in the background. In the foreground the screen already shows it,
 * so nothing fires.
 */

let ready = false;

export async function setupNotifications(): Promise<void> {
  if (ready) return;
  try {
    Notifications.setNotificationHandler({
      // If one fires while the app is foregrounded anyway (race), stay quiet.
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("agent", {
        name: "Agent",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 180, 90, 180],
      });
    }
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) await Notifications.requestPermissionsAsync();
    ready = true;
  } catch {
    // A phone that refuses notifications still gets a working app.
  }
}

export type NotifyKind = "done" | "error" | "permission" | "question";

const TITLE_KEY: Record<NotifyKind, Parameters<typeof t>[0]> = {
  done: "notif.done",
  error: "notif.error",
  permission: "notif.permission",
  question: "notif.question",
};

export function notify(kind: NotifyKind, body?: string): void {
  // Foreground = the transcript is right there; only a backgrounded phone
  // needs a nudge.
  if (AppState.currentState === "active") return;
  if (!ready) return;
  void Notifications.scheduleNotificationAsync({
    content: {
      title: t(TITLE_KEY[kind]),
      ...(body ? { body } : {}),
      ...(Platform.OS === "android" ? { channelId: "agent" } : {}),
    },
    trigger: null,
  }).catch(() => undefined);
}
