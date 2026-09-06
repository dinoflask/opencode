import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { extractPromptFromParts } from "./prompt"

describe("extractPromptFromParts", () => {
  const message = { sessionID: "ses_1", messageID: "msg_1" }

  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      {
        type: "image",
        filename: "a.png",
        mime: "image/png",
        blob: expect.objectContaining({ id: expect.any(String) }),
      },
      {
        type: "image",
        filename: "b.pdf",
        mime: "application/pdf",
        blob: expect.objectContaining({ id: expect.any(String) }),
      },
    ])
  })

  test("restores files without text", () => {
    const parts = [
      {
        ...message,
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "image.png",
      },
      {
        ...message,
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "document.pdf",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "image.png", mime: "image/png" },
      { type: "image", filename: "document.pdf", mime: "application/pdf" },
    ])
  })

  test("interleaves inline files and text", () => {
    const text = "read @src/app.ts then check @src/config.ts"
    const first = "@src/app.ts"
    const second = "@src/config.ts"
    const parts = [
      { ...message, id: "text_1", type: "text", text },
      {
        ...message,
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///workspace/src/app.ts",
        source: { type: "file", path: "src/app.ts", text: { value: first, start: 5, end: 16 } },
      },
      {
        ...message,
        id: "file_2",
        type: "file",
        mime: "text/plain",
        url: "file:///workspace/src/config.ts",
        source: { type: "file", path: "src/config.ts", text: { value: second, start: 28, end: 43 } },
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toMatchObject([
      { type: "text", content: "read " },
      { type: "file", path: "src/app.ts", content: first },
      { type: "text", content: " then check " },
      { type: "file", path: "src/config.ts", content: second },
    ])
  })

  test("interleaves agent mentions and text", () => {
    const text = "ask @planner to review"
    const parts = [
      { ...message, id: "text_1", type: "text", text },
      {
        ...message,
        id: "agent_1",
        type: "agent",
        name: "planner",
        source: { value: "@planner", start: 4, end: 12 },
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toMatchObject([
      { type: "text", content: "ask " },
      { type: "agent", name: "planner", content: "@planner" },
      { type: "text", content: " to review" },
    ])
  })

  test("restores a prompt with only images", () => {
    const parts = [
      {
        ...message,
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "text", content: "" })
    expect(result[1]).toMatchObject({ type: "image", mime: "image/png" })
  })

  test("restores text when there are no inline parts", () => {
    const parts = [{ ...message, id: "text_1", type: "text", text: "just text" }] satisfies Part[]

    expect(extractPromptFromParts(parts)).toMatchObject([{ type: "text", content: "just text" }])
  })

  // Stale offsets occur when metadata was recorded for an earlier version of
  // the prompt. The value is still present, so reconstruction searches for it.
  test("recovers inline files with stale offsets", () => {
    const parts = [
      { ...message, id: "text_1", type: "text", text: "use @src/app.ts" },
      {
        ...message,
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///workspace/src/app.ts",
        source: { type: "file", path: "src/app.ts", text: { value: "@src/app.ts", start: 0, end: 11 } },
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toMatchObject([
      { type: "text", content: "use " },
      { type: "file", path: "src/app.ts", content: "@src/app.ts" },
    ])
  })
})
