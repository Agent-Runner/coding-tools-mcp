import React from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Locale = "en" | "zh";

export type Release030Props = {
  locale: Locale;
};

const BG = "#0b0f14";
const PANEL = "#11161d";
const BORDER = "#1f2733";
const TEXT = "#e6edf3";
const DIM = "#8b949e";
const GREEN = "#4ade80";
const CYAN = "#38bdf8";
const RED = "#f87171";
const AMBER = "#fbbf24";
const EN_MONO =
  "ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, monospace";
const ZH_SANS = "'WenQuanYi Micro Hei', 'Droid Sans Fallback', sans-serif";
const ZH_MONO =
  "'WenQuanYi Micro Hei Mono', ui-monospace, 'SF Mono', monospace";

export const DURATION = {
  title: 120,
  protocol: 240,
  stateless: 210,
  commands: 240,
  patches: 210,
  errors: 210,
  cta: 210,
} as const;

export const RELEASE_030_FRAMES =
  DURATION.title +
  DURATION.protocol +
  DURATION.stateless +
  DURATION.commands +
  DURATION.patches +
  DURATION.errors +
  DURATION.cta;

const FROM = {
  title: 0,
  protocol: DURATION.title,
  stateless: DURATION.title + DURATION.protocol,
  commands: DURATION.title + DURATION.protocol + DURATION.stateless,
  patches:
    DURATION.title +
    DURATION.protocol +
    DURATION.stateless +
    DURATION.commands,
  errors:
    DURATION.title +
    DURATION.protocol +
    DURATION.stateless +
    DURATION.commands +
    DURATION.patches,
  cta:
    DURATION.title +
    DURATION.protocol +
    DURATION.stateless +
    DURATION.commands +
    DURATION.patches +
    DURATION.errors,
};

const COPY = {
  en: {
    kicker: "RELEASE",
    product: "Coding Tools MCP",
    tagline: "No sessions. Two protocol eras. One workspace.",
    protocolTitle: "Full MCP 2026-07-28",
    protocolSub: "The handshake is no longer an admission gate.",
    protocolFlow: "server/discover  →  tools/list  →  tools/call",
    protocolNote: "Handshake-era 2025-11-25 / 2025-06-18 keep their byte shape.",
    protoNew: "NEW · FULL",
    protoHand: "handshake",
    statelessTitle: "HTTP has no sessions.",
    statelessStrike: "Mcp-Session-Id",
    statelessGone: "gone",
    statelessPoints: [
      "No session header issued",
      "No 128-session ceiling",
      "No idle expiry",
    ],
    statelessFooter: "One workspace  ·  one runtime  ·  every authenticated client",
    commandsTitle: "Commands outlive the connection.",
    cmdStep1: "exec_command  →  command_id: 7f3a",
    cmdStep2: "HTTP connection closed",
    cmdStep3: "write_stdin(command_id: 7f3a)  still running",
    cmdRename1: "kill_session  →  kill_command",
    cmdRename2: "session_id    →  command_id",
    patchesTitle: "Two clients, one file.",
    patchesSub: "A retryable conflict — not a silent overwrite.",
    clientA: "Client A",
    clientB: "Client B",
    patchOk: "✓  committed",
    patchConflict: "⚠  conflict · retryable",
    patchNote: "apply_patch also keeps the line endings it was not asked to touch.",
    errorsTitle: "Errors the model can actually see.",
    errorLine1: "PATH_NOT_FOUND  ·  retryable: false  ·  category: path",
    errorLine2: "Do not repeat this call — it cannot succeed.",
    outputTitle: "Command output keeps the head AND the tail.",
    outputHead: "[HEAD] ImportError: No module named 'app.core'",
    outputGap: "···  evicted 1.2 MB  ···",
    outputTail: "[TAIL] ===================== 1 failed in 0.03s",
    ctaMeta: "18 tools  ·  Apache-2.0  ·  PyPI + npm",
    ctaCmd: "npx coding-tools-mcp",
    ctaMig: "docs/migration-0.3.md",
    ctaRepo: "github.com/xyTom/coding-tools-mcp",
    versions: [
      { id: "2026-07-28", tag: "NEW · FULL" },
      { id: "2025-11-25", tag: "handshake" },
      { id: "2025-06-18", tag: "handshake" },
    ],
  },
  zh: {
    kicker: "RELEASE",
    product: "Coding Tools MCP",
    tagline: "没有会话。两代协议。一个工作区。",
    protocolTitle: "完整支持 MCP 2026-07-28",
    protocolSub: "握手不再是入场券。",
    protocolFlow: "server/discover  →  tools/list  →  tools/call",
    protocolNote: "握手时代 2025-11-25 / 2025-06-18 字节形状不变。",
    protoNew: "新 · 全量",
    protoHand: "握手时代",
    statelessTitle: "HTTP 彻底无状态。",
    statelessStrike: "Mcp-Session-Id",
    statelessGone: "已删除",
    statelessPoints: ["不再签发会话头", "没有 128 会话上限", "没有空闲过期"],
    statelessFooter: "一个工作区  ·  一个运行时  ·  每个已认证客户端",
    commandsTitle: "命令活过断线。",
    cmdStep1: "exec_command  →  command_id: 7f3a",
    cmdStep2: "HTTP 连接已关闭",
    cmdStep3: "write_stdin(command_id: 7f3a)  仍在运行",
    cmdRename1: "kill_session  →  kill_command",
    cmdRename2: "session_id    →  command_id",
    patchesTitle: "两个客户端，同一个文件。",
    patchesSub: "后来者拿到可重试冲突，而不是静默覆盖。",
    clientA: "客户端 A",
    clientB: "客户端 B",
    patchOk: "✓  已提交",
    patchConflict: "⚠  冲突 · 可重试",
    patchNote: "apply_patch 也不再改写它没被要求动的行结束符。",
    errorsTitle: "模型终于看得见错误。",
    errorLine1: "PATH_NOT_FOUND  ·  retryable: false  ·  category: path",
    errorLine2: "不要重复这次调用 —— 它不可能成功。",
    outputTitle: "命令输出同时保留开头和末尾。",
    outputHead: "[HEAD] ImportError: No module named 'app.core'",
    outputGap: "···  已淘汰 1.2 MB  ···",
    outputTail: "[TAIL] ===================== 1 failed in 0.03s",
    ctaMeta: "18 个工具  ·  Apache-2.0  ·  PyPI + npm",
    ctaCmd: "npx coding-tools-mcp",
    ctaMig: "docs/migration-0.3.md",
    ctaRepo: "github.com/xyTom/coding-tools-mcp",
    versions: [
      { id: "2026-07-28", tag: "新 · 全量" },
      { id: "2025-11-25", tag: "握手时代" },
      { id: "2025-06-18", tag: "握手时代" },
    ],
  },
} as const;

const fontStack = (locale: Locale, mono: boolean): string => {
  if (locale === "zh") {
    return mono ? ZH_MONO : ZH_SANS;
  }
  return EN_MONO;
};

const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      background:
        "radial-gradient(ellipse at 50% 38%, rgba(56,189,248,0.08), transparent 55%), radial-gradient(ellipse at 80% 110%, rgba(74,222,128,0.07), transparent 48%)",
      pointerEvents: "none",
    }}
  />
);

const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const width = interpolate(frame, [0, durationInFrames - 1], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        height: 6,
        width: `${width}%`,
        background: GREEN,
        boxShadow: "0 0 16px rgba(74,222,128,0.45)",
      }}
    />
  );
};

const CornerMark: React.FC<{ locale: Locale }> = ({ locale }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [DURATION.title - 8, DURATION.title + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        top: 40,
        left: 56,
        opacity,
        color: DIM,
        fontSize: 22,
        letterSpacing: 1.5,
        fontFamily: fontStack(locale, true),
      }}
    >
      coding-tools-mcp  ·  0.3.0
    </div>
  );
};

const Typed: React.FC<{
  text: string;
  startFrame: number;
  charsPerFrame?: number;
  cursor?: boolean;
  style?: React.CSSProperties;
}> = ({ text, startFrame, charsPerFrame = 1.2, cursor = true, style }) => {
  const frame = useCurrentFrame();
  const visible = Math.max(0, Math.floor((frame - startFrame) * charsPerFrame));
  const done = visible >= text.length;
  const blink = Math.floor(frame / 15) % 2 === 0;
  return (
    <span style={{ whiteSpace: "pre", ...style }}>
      {text.slice(0, visible)}
      {cursor && (!done || blink) && frame >= startFrame ? (
        <span style={{ color: GREEN }}>▊</span>
      ) : null}
    </span>
  );
};

const FadeUp: React.FC<{
  delay: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ delay, children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
  });
  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${interpolate(progress, [0, 1], [18, 0])}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const SceneFade: React.FC<{
  children: React.ReactNode;
  duration: number;
  fadeOutStart?: number;
}> = ({ children, duration, fadeOutStart }) => {
  const frame = useCurrentFrame();
  const start = fadeOutStart ?? duration - 16;
  const opacity = interpolate(frame, [0, 10, start, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const Panel: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
  accent?: string;
}> = ({ children, style, accent }) => (
  <div
    style={{
      background: PANEL,
      border: `2px solid ${accent ?? BORDER}`,
      borderRadius: 20,
      padding: "32px 40px",
      ...style,
    }}
  >
    {children}
  </div>
);

const TitleScene: React.FC<{ locale: Locale }> = ({ locale }) => {
  const t = COPY[locale];
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const stamp = spring({
    frame: frame - 18,
    fps,
    config: { damping: 14, mass: 0.7, stiffness: 120 },
  });
  return (
    <SceneFade duration={DURATION.title}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 28,
          fontFamily: fontStack(locale, false),
        }}
      >
        <FadeUp delay={4}>
          <div
            style={{
              fontSize: 28,
              letterSpacing: 10,
              color: CYAN,
              fontFamily: fontStack(locale, true),
            }}
          >
            {t.kicker}
          </div>
        </FadeUp>
        <div
          style={{
            fontSize: 188,
            fontWeight: 800,
            color: TEXT,
            letterSpacing: 4,
            fontFamily:
              locale === "zh"
                ? ZH_SANS
                : "ui-sans-serif, system-ui, -apple-system, sans-serif",
            transform: `scale(${interpolate(stamp, [0, 1], [0.72, 1])})`,
            textShadow: "0 0 80px rgba(74,222,128,0.28)",
          }}
        >
          0.3.0
        </div>
        <FadeUp delay={48}>
          <div
            style={{
              fontSize: 42,
              color: GREEN,
              fontFamily: fontStack(locale, true),
            }}
          >
            {t.product}
          </div>
        </FadeUp>
        <FadeUp delay={68}>
          <div style={{ fontSize: 36, color: DIM }}>{t.tagline}</div>
        </FadeUp>
      </AbsoluteFill>
    </SceneFade>
  );
};

const ProtocolScene: React.FC<{ locale: Locale }> = ({ locale }) => {
  const t = COPY[locale];
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <SceneFade duration={DURATION.protocol}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 36,
          fontFamily: fontStack(locale, false),
        }}
      >
        <FadeUp delay={6}>
          <div style={{ fontSize: 64, fontWeight: 700, color: TEXT }}>
            {t.protocolTitle}
          </div>
        </FadeUp>
        <div style={{ display: "flex", gap: 36 }}>
          {t.versions.map((v, i) => {
            const p = spring({
              frame: frame - 28 - i * 12,
              fps,
              config: { damping: 160 },
            });
            const isNew = i === 0;
            return (
              <div
                key={v.id}
                style={{
                  opacity: p,
                  transform: `translateY(${interpolate(p, [0, 1], [50, 0])}px)`,
                  width: 420,
                  background: PANEL,
                  border: `3px solid ${isNew ? GREEN : BORDER}`,
                  boxShadow: isNew ? "0 0 50px rgba(74,222,128,0.22)" : "none",
                  borderRadius: 22,
                  padding: "36px 32px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 40,
                    fontWeight: 700,
                    color: isNew ? GREEN : TEXT,
                    fontFamily: fontStack(locale, true),
                    marginBottom: 16,
                  }}
                >
                  {v.id}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    color: isNew ? GREEN : DIM,
                    fontFamily: fontStack(locale, true),
                    letterSpacing: 1,
                  }}
                >
                  {v.tag}
                </div>
              </div>
            );
          })}
        </div>
        <FadeUp delay={90}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 18,
            }}
          >
            <div style={{ fontSize: 40, color: TEXT }}>{t.protocolSub}</div>
            <div
              style={{
                fontSize: 32,
                color: CYAN,
                fontFamily: fontStack(locale, true),
              }}
            >
              {t.protocolFlow}
            </div>
            <div style={{ fontSize: 28, color: DIM }}>{t.protocolNote}</div>
          </div>
        </FadeUp>
      </AbsoluteFill>
    </SceneFade>
  );
};

const StatelessScene: React.FC<{ locale: Locale }> = ({ locale }) => {
  const t = COPY[locale];
  const frame = useCurrentFrame();
  const strike = interpolate(frame, [40, 58], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <SceneFade duration={DURATION.stateless}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 52,
          fontFamily: fontStack(locale, false),
        }}
      >
        <FadeUp delay={6}>
          <div style={{ fontSize: 64, fontWeight: 700, color: TEXT }}>
            {t.statelessTitle}
          </div>
        </FadeUp>
        <FadeUp delay={24}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 28,
              fontSize: 52,
              fontFamily: fontStack(locale, true),
              color: TEXT,
              background: PANEL,
              border: `2px solid ${BORDER}`,
              borderRadius: 16,
              padding: "22px 48px",
            }}
          >
            <span
              style={{
                position: "relative",
                display: "inline-block",
                overflow: "hidden",
                padding: "4px 0",
              }}
            >
              {t.statelessStrike}: 8e2c…f91
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: "48%",
                  height: 6,
                  width: `${strike * 100}%`,
                  background: RED,
                  transform: "rotate(-3deg)",
                  transformOrigin: "left center",
                  boxShadow: "0 0 12px rgba(248,113,113,0.6)",
                }}
              />
            </span>
            <span
              style={{
                color: RED,
                fontSize: 32,
                opacity: strike,
              }}
            >
              {t.statelessGone}
            </span>
          </div>
        </FadeUp>
        <div style={{ display: "flex", gap: 28 }}>
          {t.statelessPoints.map((point, i) => (
            <FadeUp key={point} delay={70 + i * 14}>
              <Panel style={{ width: 460, textAlign: "center" }}>
                <div style={{ fontSize: 30, color: DIM, lineHeight: 1.5 }}>
                  {point}
                </div>
              </Panel>
            </FadeUp>
          ))}
        </div>
        <FadeUp delay={96}>
          <div style={{ fontSize: 34, color: GREEN }}>{t.statelessFooter}</div>
        </FadeUp>
      </AbsoluteFill>
    </SceneFade>
  );
};

const CommandsScene: React.FC<{ locale: Locale }> = ({ locale }) => {
  const t = COPY[locale];
  const frame = useCurrentFrame();
  const steps = [
    { text: t.cmdStep1, color: CYAN, at: 36 },
    { text: t.cmdStep2, color: AMBER, at: 78 },
    { text: t.cmdStep3, color: GREEN, at: 120 },
  ];
  return (
    <SceneFade duration={DURATION.commands}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 44,
          fontFamily: fontStack(locale, false),
        }}
      >
        <FadeUp delay={6}>
          <div style={{ fontSize: 64, fontWeight: 700, color: TEXT }}>
            {t.commandsTitle}
          </div>
        </FadeUp>
        <Panel
          style={{
            width: 1320,
            fontFamily: fontStack(locale, true),
            padding: "28px 36px 36px",
          }}
        >
          <div style={{ display: "flex", gap: 12, marginBottom: 28 }}>
            {[RED, AMBER, GREEN].map((c) => (
              <div
                key={c}
                style={{ width: 18, height: 18, borderRadius: 9, background: c }}
              />
            ))}
          </div>
          {steps.map((step, i) => (
            <div
              key={step.text}
              style={{
                opacity: frame > step.at ? 1 : 0.18,
                color: step.color,
                fontSize: 34,
                lineHeight: 2,
              }}
            >
              <span style={{ color: DIM, marginRight: 16 }}>{i + 1}.</span>
              {step.text}
            </div>
          ))}
        </Panel>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <FadeUp delay={108}>
            <div
              style={{
                fontSize: 30,
                color: DIM,
                fontFamily: fontStack(locale, true),
              }}
            >
              {t.cmdRename1}
            </div>
          </FadeUp>
          <FadeUp delay={122}>
            <div
              style={{
                fontSize: 30,
                color: DIM,
                fontFamily: fontStack(locale, true),
              }}
            >
              {t.cmdRename2}
            </div>
          </FadeUp>
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const PatchesScene: React.FC<{ locale: Locale }> = ({ locale }) => {
  const t = COPY[locale];
  return (
    <SceneFade duration={DURATION.patches}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 44,
          fontFamily: fontStack(locale, false),
        }}
      >
        <FadeUp delay={6}>
          <div style={{ fontSize: 64, fontWeight: 700, color: TEXT }}>
            {t.patchesTitle}
          </div>
        </FadeUp>
        <FadeUp delay={18}>
          <div style={{ fontSize: 34, color: DIM }}>{t.patchesSub}</div>
        </FadeUp>
        <div style={{ display: "flex", gap: 36, alignItems: "center" }}>
          <FadeUp delay={40}>
            <Panel accent={GREEN} style={{ width: 520, minHeight: 260 }}>
              <div
                style={{
                  fontSize: 28,
                  color: GREEN,
                  marginBottom: 18,
                  fontFamily: fontStack(locale, true),
                }}
              >
                {t.clientA}
              </div>
              <div
                style={{
                  fontSize: 26,
                  color: DIM,
                  fontFamily: fontStack(locale, true),
                  marginBottom: 12,
                }}
              >
                apply_patch
              </div>
              <div
                style={{
                  fontSize: 34,
                  color: TEXT,
                  fontFamily: fontStack(locale, true),
                  lineHeight: 1.5,
                }}
              >
                {t.patchOk}
              </div>
            </Panel>
          </FadeUp>
          <FadeUp delay={70}>
            <div
              style={{
                width: 180,
                height: 180,
                borderRadius: 24,
                border: `2px solid ${BORDER}`,
                background: PANEL,
                color: TEXT,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: fontStack(locale, true),
                fontSize: 28,
                textAlign: "center",
                lineHeight: 1.4,
              }}
            >
              src/
              <br />
              app.py
            </div>
          </FadeUp>
          <FadeUp delay={100}>
            <Panel accent={AMBER} style={{ width: 520, minHeight: 260 }}>
              <div
                style={{
                  fontSize: 28,
                  color: AMBER,
                  marginBottom: 18,
                  fontFamily: fontStack(locale, true),
                }}
              >
                {t.clientB}
              </div>
              <div
                style={{
                  fontSize: 26,
                  color: DIM,
                  fontFamily: fontStack(locale, true),
                  marginBottom: 12,
                }}
              >
                apply_patch
              </div>
              <div
                style={{
                  fontSize: 34,
                  color: TEXT,
                  fontFamily: fontStack(locale, true),
                  lineHeight: 1.5,
                }}
              >
                {t.patchConflict}
              </div>
            </Panel>
          </FadeUp>
        </div>
        <FadeUp delay={140}>
          <div style={{ fontSize: 30, color: DIM }}>{t.patchNote}</div>
        </FadeUp>
      </AbsoluteFill>
    </SceneFade>
  );
};

const ErrorsScene: React.FC<{ locale: Locale }> = ({ locale }) => {
  const t = COPY[locale];
  return (
    <SceneFade duration={DURATION.errors}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 40,
          fontFamily: fontStack(locale, false),
        }}
      >
        <FadeUp delay={6}>
          <div style={{ fontSize: 58, fontWeight: 700, color: TEXT }}>
            {t.errorsTitle}
          </div>
        </FadeUp>
        <FadeUp delay={24}>
          <Panel
            accent={RED}
            style={{ width: 1400, fontFamily: fontStack(locale, true) }}
          >
            <div style={{ fontSize: 32, color: RED, marginBottom: 12 }}>
              {t.errorLine1}
            </div>
            <div style={{ fontSize: 30, color: DIM }}>{t.errorLine2}</div>
          </Panel>
        </FadeUp>
        <FadeUp delay={70}>
          <div style={{ fontSize: 36, color: TEXT }}>{t.outputTitle}</div>
        </FadeUp>
        <FadeUp delay={90}>
          <Panel
            style={{
              width: 1400,
              fontFamily: fontStack(locale, true),
              fontSize: 28,
              lineHeight: 1.85,
            }}
          >
            <div style={{ color: GREEN }}>{t.outputHead}</div>
            <div style={{ color: DIM }}>{t.outputGap}</div>
            <div style={{ color: CYAN }}>{t.outputTail}</div>
          </Panel>
        </FadeUp>
      </AbsoluteFill>
    </SceneFade>
  );
};

const CtaScene: React.FC<{ locale: Locale }> = ({ locale }) => {
  const t = COPY[locale];
  return (
    <SceneFade duration={DURATION.cta} fadeOutStart={DURATION.cta - 14}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          gap: 40,
          fontFamily: fontStack(locale, false),
        }}
      >
        <FadeUp delay={6}>
          <div
            style={{
              fontSize: 32,
              color: DIM,
              fontFamily: fontStack(locale, true),
            }}
          >
            {t.ctaMeta}
          </div>
        </FadeUp>
        <FadeUp delay={24}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              color: GREEN,
              fontFamily: fontStack(locale, true),
              border: `3px solid ${GREEN}`,
              borderRadius: 24,
              padding: "32px 72px",
              boxShadow: "0 0 80px rgba(74,222,128,0.25)",
            }}
          >
            {t.ctaCmd}
          </div>
        </FadeUp>
        <FadeUp delay={50}>
          <div
            style={{
              fontSize: 34,
              color: CYAN,
              fontFamily: fontStack(locale, true),
            }}
          >
            {t.ctaMig}
          </div>
        </FadeUp>
        <FadeUp delay={70}>
          <div
            style={{
              fontSize: 36,
              color: TEXT,
              fontFamily: fontStack(locale, true),
            }}
          >
            {t.ctaRepo}
          </div>
        </FadeUp>
      </AbsoluteFill>
    </SceneFade>
  );
};

export const Release030: React.FC<Release030Props> = ({ locale }) => {
  return (
    <AbsoluteFill
      style={{
        background: BG,
        color: TEXT,
        fontFamily: fontStack(locale, true),
      }}
    >
      <Vignette />
      <CornerMark locale={locale} />
      <Sequence durationInFrames={DURATION.title}>
        <TitleScene locale={locale} />
      </Sequence>
      <Sequence from={FROM.protocol} durationInFrames={DURATION.protocol}>
        <ProtocolScene locale={locale} />
      </Sequence>
      <Sequence from={FROM.stateless} durationInFrames={DURATION.stateless}>
        <StatelessScene locale={locale} />
      </Sequence>
      <Sequence from={FROM.commands} durationInFrames={DURATION.commands}>
        <CommandsScene locale={locale} />
      </Sequence>
      <Sequence from={FROM.patches} durationInFrames={DURATION.patches}>
        <PatchesScene locale={locale} />
      </Sequence>
      <Sequence from={FROM.errors} durationInFrames={DURATION.errors}>
        <ErrorsScene locale={locale} />
      </Sequence>
      <Sequence from={FROM.cta} durationInFrames={DURATION.cta}>
        <CtaScene locale={locale} />
      </Sequence>
      <ProgressBar />
    </AbsoluteFill>
  );
};
