import React from "react";
import { Box, Static, Text } from "ink";
import type { BannerData, TranscriptItem, TranscriptSpan } from "../transcript.js";
import { glyphs, palette } from "../theme.js";

/**
 * Committed transcript rendered through <Static>: items are painted once and
 * flow into the terminal scrollback, exactly like Claude Code's conversation
 * log. Only the live region below ever re-renders.
 */
export function Transcript({ items, epoch }: { items: TranscriptItem[]; epoch: number }): React.ReactElement {
  return (
    <Static key={epoch} items={items}>
      {(item) =>
        item.kind === "banner" ? (
          <Banner key={item.key} data={item.banner} />
        ) : (
          <Box key={item.key} flexDirection="column">
            {item.lines.map((line, index) => (
              <SpanLine key={index} spans={line} />
            ))}
          </Box>
        )
      }
    </Static>
  );
}

function SpanLine({ spans }: { spans: TranscriptSpan[] }): React.ReactElement {
  return (
    <Text wrap="truncate-end">
      {spans.map((span, index) => (
        <Text key={index} color={span.color} dimColor={span.dim} bold={span.bold}>
          {span.text || " "}
        </Text>
      ))}
    </Text>
  );
}

function Banner({ data }: { data: BannerData }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1} marginBottom={1}>
      <Text>
        <Text color={palette.accent}>{glyphs.working} </Text>
        <Text bold>{data.title}</Text>
        <Text dimColor> v{data.version}</Text>
      </Text>
      <Text dimColor>  {data.workspace}</Text>
      <Text> </Text>
      {data.tips.map((tip) => (
        <Text key={tip} dimColor>
          {"  "}
          {tip}
        </Text>
      ))}
    </Box>
  );
}
