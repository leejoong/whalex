import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
// Per-weight subpaths, not the package roots: importing the index pulls every
// weight and italic of both families into the bundle (~5 MB of unused fonts).
import { useFonts } from "expo-font";
import { IBMPlexSans_400Regular } from "@expo-google-fonts/ibm-plex-sans/400Regular";
import { IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans/500Medium";
import { IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans/600SemiBold";
import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular";
import { IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono/500Medium";
import { colors, space, type } from "./src/theme";
import type { AppLanguage } from "@whalex/shared";
import { setLanguage, t } from "./src/i18n";
import { listComputers, type PairedComputer } from "./src/lib/computers";
import { setupNotifications } from "./src/lib/notify";
import { useConnectionStore } from "./src/stores/connectionStore";
import { useMobileSession } from "./src/stores/sessionStore";
import { PairScreen } from "./src/screens/PairScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ChatScreen } from "./src/screens/ChatScreen";

void SplashScreen.preventAutoHideAsync();

type Screen = "boot" | "pair" | "connecting" | "sessions" | "chat";

export default function App() {
  const [loaded] = useFonts({
    PlexSans: IBMPlexSans_400Regular,
    PlexSansMedium: IBMPlexSans_500Medium,
    PlexSansSemi: IBMPlexSans_600SemiBold,
    PlexMono: IBMPlexMono_400Regular,
    PlexMonoMedium: IBMPlexMono_500Medium,
  });

  useEffect(() => {
    if (loaded) void SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Shell />
    </SafeAreaProvider>
  );
}

/** Design-review build: renders the real screens over sample state. */
const DEMO = process.env.EXPO_PUBLIC_DEMO === "1";

/** Scenario picker for the preview, so one bundle can show every screen. */
function demoParams(): {
  screen: string | null;
  permission: boolean;
  menu: boolean;
  lang: string | null;
} {
  if (typeof window === "undefined" || !window.location?.search) {
    return { screen: null, permission: false, menu: false, lang: null };
  }
  const q = new URLSearchParams(window.location.search);
  return {
    screen: q.get("screen"),
    permission: q.get("permission") === "1",
    menu: q.get("menu") === "1",
    lang: q.get("lang"),
  };
}

function Shell() {
  const insets = useSafeAreaInsets();
  const [screen, setScreen] = useState<Screen>(DEMO ? "sessions" : "boot");
  const phase = useConnectionStore((s) => s.phase);
  const connect = useConnectionStore((s) => s.connect);
  const kick = useConnectionStore((s) => s.kick);
  /** Once a session list has been seen, a drop is a hiccup, not a dead end. */
  const [everConnected, setEverConnected] = useState(false);

  // Boot: reconnect to the most recently used computer, else go pair.
  useEffect(() => {
    if (DEMO) {
      const p = demoParams();
      if (p.lang) setLanguage(p.lang as AppLanguage);
      void import("./src/demo").then((m) => m.seedDemo(p.permission));
      if (p.screen === "chat" || p.screen === "pair") setScreen(p.screen);
      return;
    }
    void setupNotifications();
    void (async () => {
      const computers = await listComputers();
      const last = computers.sort(
        (a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0),
      )[0];
      if (!last) {
        setScreen("pair");
        return;
      }
      // Stay on the splash until the computer answers. Dropping straight into
      // an empty session list makes a failed connection look like an account
      // with no work in it.
      setScreen("connecting");
      void connect(last);
    })();
  }, [connect]);

  // Foregrounding retries a dead connection immediately.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") kick();
    });
    return () => sub.remove();
  }, [kick]);

  // The hardware back button walks the screens instead of killing the app:
  // chat → session list, and from the list a second press within two
  // seconds exits (the standard Android press-again pattern).
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const lastBackRef = useRef(0);
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const s = screenRef.current;
      if (s === "chat") {
        useMobileSession.getState().closeSession();
        setScreen("sessions");
        return true;
      }
      if (s === "sessions") {
        const now = Date.now();
        if (now - lastBackRef.current < 2000) return false; // exit
        lastBackRef.current = now;
        if (Platform.OS === "android") {
          ToastAndroid.show(t("app.backToExit"), ToastAndroid.SHORT);
        }
        return true;
      }
      return false; // pair / connecting: default behaviour
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (phase !== "connected") return;
    // The preview seeds its own screens; the attached-landing would call a
    // socket that isn't there.
    if (DEMO) {
      setEverConnected(true);
      return;
    }
    const first = !everConnected;
    setEverConnected(true);
    // First landing: if the desktop is mid-turn, open that session — the
    // reason the phone came out of the pocket is almost always that turn.
    const attached = useConnectionStore.getState().hello?.attached;
    if (first && attached?.running && attached.sessionId && attached.cwd) {
      void useMobileSession
        .getState()
        .open(attached.cwd, attached.sessionId)
        .then(() => setScreen("chat"))
        .catch(() => setScreen("sessions"));
      return;
    }
    setScreen((s) => (s === "connecting" ? "sessions" : s));
  }, [phase, everConnected]);

  useEffect(() => {
    if (phase === "pairingRequired") setScreen("pair");
    // Never reached the computer this run — send them somewhere they can act,
    // rather than leaving a spinner on an empty screen.
    if (phase === "unreachable" && !everConnected) setScreen("pair");
  }, [phase, everConnected]);

  const onPaired = (computer: PairedComputer): void => {
    setScreen("connecting");
    void connect(computer);
  };

  // The banner sits in the layout rather than over it; as an overlay it
  // covered the screen title underneath.
  const banner = screen !== "pair" && phase !== "connected" && phase !== "pairingRequired";

  return (
    <View style={styles.root}>
      {banner && <ConnectionBanner />}
      {/* Android draws edge-to-edge, so the gesture bar sat on top of the
          composer and the last list rows; the shell owns both insets. */}
      <View
        style={[
          styles.body,
          { paddingTop: banner ? 0 : insets.top, paddingBottom: insets.bottom },
        ]}
      >
        {screen === "pair" && <PairScreen onPaired={onPaired} />}
        {screen === "connecting" && <Connecting />}
        {screen === "sessions" && <SessionsScreen onOpen={() => setScreen("chat")} />}
        {screen === "chat" && <ChatScreen onBack={() => setScreen("sessions")} />}
      </View>
    </View>
  );
}

/** Waiting on the first handshake — the app has nothing to show until then. */
function Connecting() {
  const computer = useConnectionStore((s) => s.computer);
  const lastError = useConnectionStore((s) => s.lastError);
  return (
    <View style={styles.connecting}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.connectingText}>{computer?.name ?? ""}</Text>
      {/* The raw failure, verbatim: retries are silent otherwise, and a
          connection that never lands looks identical to one still starting. */}
      {lastError && <Text style={styles.connectingError}>{lastError}</Text>}
    </View>
  );
}

/**
 * Reconnection is routine on a phone — screen off, wifi handover, a walk out
 * of range — so it says so quietly, in the layout rather than over it.
 */
function ConnectionBanner() {
  const insets = useSafeAreaInsets();
  const phase = useConnectionStore((s) => s.phase);
  return (
    <View style={[styles.banner, { paddingTop: insets.top + space.sm }]}>
      <Text style={styles.bannerText}>
        {phase === "unreachable" ? t("conn.unreachable") : t("conn.banner")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  banner: {
    paddingBottom: space.sm,
    backgroundColor: colors.attentionSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.attention,
    alignItems: "center",
  },
  bannerText: { ...type.caption, color: colors.attention, fontSize: 11.5 },
  connecting: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
  connectingText: { ...type.caption, color: colors.muted },
  connectingError: {
    ...type.caption,
    color: colors.danger,
    textAlign: "center",
    paddingHorizontal: space.xl,
  },
});
