const TITLE_LIMIT = 80;
const BODY_LIMIT = 240;

const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
  "$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_NOTIFY_TITLE_B64))",
  "$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_NOTIFY_BODY_B64))",
  "$text = $xml.GetElementsByTagName('text')",
  "$null = $text[0].AppendChild($xml.CreateTextNode($title))",
  "$null = $text[1].AppendChild($xml.CreateTextNode($body))",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)",
].join("; ");

export type NotificationTransport =
  | {
      readonly kind: "osc";
      readonly protocol: "osc99" | "osc777";
      readonly data: string;
    }
  | {
      readonly kind: "windows";
      readonly file: "powershell.exe";
      readonly args: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly fallbackData: string;
    };

function stripTerminalControls(value: string) {
  return value
    .replaceAll("\u001b\\", "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function sanitizeNotificationText(value: string, limit: number) {
  return Array.from(stripTerminalControls(value)).slice(0, limit).join("");
}

export function sanitizeNotification(title: string, body: string) {
  return {
    title: sanitizeNotificationText(title, TITLE_LIMIT),
    body: sanitizeNotificationText(body, BODY_LIMIT),
  };
}

export function buildOsc99Notification(title: string, body: string) {
  const safe = sanitizeNotification(title, body);
  return [
    `\u001b]99;i=pi-notify:d=0;${safe.title}\u001b\\`,
    `\u001b]99;i=pi-notify:p=body;${safe.body}\u001b\\`,
  ].join("");
}

export function buildOsc777Notification(title: string, body: string) {
  const safe = sanitizeNotification(title, body);
  return `\u001b]777;notify;${safe.title};${safe.body}\u0007`;
}

export function buildWindowsToastCommand(title: string, body: string) {
  const safe = sanitizeNotification(title, body);
  return {
    kind: "windows",
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_TOAST_SCRIPT,
    ],
    environment: {
      PI_NOTIFY_TITLE_B64: Buffer.from(safe.title, "utf8").toString("base64"),
      PI_NOTIFY_BODY_B64: Buffer.from(safe.body, "utf8").toString("base64"),
    },
    fallbackData: buildOsc777Notification(safe.title, safe.body),
  } satisfies NotificationTransport;
}

export function buildNotificationTransport(
  environment: Readonly<Record<string, string | undefined>>,
  title: string,
  body: string,
) {
  if (environment.WT_SESSION) {
    return buildWindowsToastCommand(title, body);
  }

  if (environment.KITTY_WINDOW_ID) {
    return {
      kind: "osc",
      protocol: "osc99",
      data: buildOsc99Notification(title, body),
    } satisfies NotificationTransport;
  }

  return {
    kind: "osc",
    protocol: "osc777",
    data: buildOsc777Notification(title, body),
  } satisfies NotificationTransport;
}
