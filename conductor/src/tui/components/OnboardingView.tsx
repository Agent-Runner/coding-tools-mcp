import React from "react";
import { Box, Text } from "ink";
import { onboardingPrompt, type OnboardingState } from "../onboarding.js";
import { glyphs, palette } from "../theme.js";
import { SelectList, type SelectOption } from "./SelectList.js";

export interface OnboardingOption extends SelectOption {
  value: string;
  requiresInput?: boolean;
}

export function optionsForStep(state: OnboardingState): OnboardingOption[] {
  if (state.step === "backend") {
    return [
      { label: "stdio (default)", value: "stdio", hint: "Spawn coding-tools-mcp locally over stdio." },
      { label: "docker", value: "docker", hint: "Use the dockerized lower backend." },
      {
        label: "http(s) URL…",
        value: "",
        requiresInput: true,
        hint: "Type the remote MCP HTTP URL, e.g. http://127.0.0.1:8765/mcp, then press Enter.",
      },
    ];
  }
  return [
    { label: "safe (default)", value: "safe", hint: "Ask in this TUI before risky operations." },
    { label: "trusted", value: "trusted", hint: "Skip approval prompts for this repo." },
  ];
}

export function OnboardingView({
  state,
  options,
  choice,
}: {
  state: OnboardingState;
  options: OnboardingOption[];
  choice: number;
}): React.ReactElement {
  const steps: OnboardingState["step"][] = ["backend", "permissions"];
  const stepNumber = steps.indexOf(state.step) + 1;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Text bold>
        Set up this repo <Text dimColor>{glyphs.dot} step {String(stepNumber)}/2</Text>
      </Text>
      <Text dimColor>{state.repoPath}</Text>
      <Text> </Text>
      <Text>{onboardingPrompt(state)}</Text>
      <SelectList options={options} selected={choice} />
      <Text> </Text>
      <Text dimColor>↑/↓ choose {glyphs.dot} Enter accept {glyphs.dot} or type a value and press Enter</Text>
    </Box>
  );
}
