import type { AgentPart as MessageAgentPart, FilePart, Part, TextPart } from "@opencode-ai/sdk/v2"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { createLegacyBlobReference } from "@/utils/draft-store"

// Intermediate representation for inline file and agent references while the
// original prompt text is reconstructed.
type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      selection?: {
        startLine: number
        endLine: number
        startChar: number
        endChar: number
      }
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }

function selectionFromFileUrl(url: string): Extract<Inline, { type: "file" }>["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

function textPartValue(parts: Part[]) {
  const candidates = parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

const toRelative = (path: string, directory: string | undefined) => {
  if (!directory) return path

  const prefix = directory.endsWith("/") ? directory : directory + "/"
  if (path.startsWith(prefix)) return path.slice(prefix.length)

  if (path.startsWith(directory)) {
    const next = path.slice(directory.length)
    if (next.startsWith("/")) return next.slice(1)
    return next
  }

  return path
}

// For use in reconstructPrompt(). Returns inline file and agent references
// separately from image attachments, which are appended after reconstruction.
function collectInlineParts(parts: Part[],
  options: {
    directory?: string
    attachmentName: string },)
  {

  const inline: Inline[] = []
  const images: ImageAttachmentPart[] = []

  for (const part of parts) {
  if (part.type === "file") {
    const collected = collectFilePart(part as FilePart, options)
    if (collected?.inline) inline.push(collected.inline)
    if (collected?.image) images.push(collected.image)
    continue
  }

  if (part.type === "agent") {
    const agent = collectAgentPart(part as MessageAgentPart)
    if (agent) inline.push(agent)
  }
  // Sort original inline stuff (files and agents)
  
}
  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  return { inline, images }
}

// Converts a file part into either an inline reference or an image attachment.
function collectFilePart(filePart: FilePart, options: { directory?: string; attachmentName: string }) {
  const sourceText = filePart.source?.text
  if (sourceText) {
    const value = sourceText.value
    let path = value
    if (value.startsWith("@")) path = value.slice(1)
    if (!value.startsWith("@") && filePart.source && "path" in filePart.source) {
      path = filePart.source.path
    }
    return {
      inline: {
        type: "file" as const,
        start: sourceText.start,
        end: sourceText.end,
        value,
        path: toRelative(path, options.directory),
        selection: selectionFromFileUrl(filePart.url),
      },
    }
  }

  if (!filePart.url.startsWith("data:")) return undefined
  return {
    image: {
      type: "image" as const,
      id: filePart.id,
      filename: filePart.filename ?? options.attachmentName,
      mime: filePart.mime,
      blob: createLegacyBlobReference(filePart.url),
    },
  }
}

// Converts an agent part into an inline reference when it has source text.
function collectAgentPart(agentPart: MessageAgentPart): Extract<Inline, { type: "agent" }> | undefined {
  const source = agentPart.source
  if (!source) return undefined
  return {
    type: "agent",
    start: source.start,
    end: source.end,
    value: source.value,
    name: agentPart.name,
  }
}

// Finds an inline reference in the text, falling back to a search if its
// original offsets no longer match.
function findInlineMatch(text: string, item: Inline, cursor: number) {
  if (item.start < 0 || item.end < item.start || !item.value) return undefined
  const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== item.value
  const start = mismatch ? text.indexOf(item.value, cursor) : item.start
  if (start === -1) return undefined
  return { start, end: mismatch ? start + item.value.length : item.end }
}

// Rebuilds the prompt by interleaving ordinary text with inline file and agent parts.
function reconstructPrompt(text: string, inline: Inline[]):Prompt {
  let result: Prompt = []
  let position = 0
  let cursor = 0

// Helper to push prompt-class readable JSON onto the result
const pushText = (content: string) => {
  if (!content) return
  result.push({
    type: "text",
    content,
    start: position,
    end: position + content.length,
  })
  position += content.length
}
// Helper to push prompt-class readable JSON onto the result
const pushFile = (item: Extract<Inline, { type: "file" }>) => {
  const content = item.value
  const attachment: FileAttachmentPart = {
    type: "file",
    path: item.path,
    content,
    start: position,
    end: position + content.length,
    selection: item.selection,
  }
  result.push(attachment)
  position += content.length
}
// Helper to push prompt-class readable JSON onto the result
const pushAgent = (item: Extract<Inline, { type: "agent" }>) => {
  const content = item.value
  const mention: AgentPart = {
    type: "agent",
    name: item.name,
    content,
    start: position,
    end: position + content.length,
  }
  result.push(mention)
  position += content.length
}

for (const item of inline) {
  // Find an Inline item
  const match = findInlineMatch(text, item, cursor)
  if (!match) continue

  // Push all ordinary text before the item
  pushText(text.slice(cursor, match.start))

  if (item.type === "file") pushFile(item)
  if (item.type === "agent") pushAgent(item)

  cursor = match.end
}

// After all the inline objects are pushed, push the remaining text.
pushText(text.slice(cursor))
return result
}

/**
 * Extract prompt content from message parts for restoring into the prompt input.
 * This is used by undo to restore the original user prompt.
 */
export function extractPromptFromParts(parts: Part[], opts?: { directory?: string; attachmentName?: string }): Prompt {
  
  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const attachmentName = opts?.attachmentName ?? "attachment"

  const { inline, images } = collectInlineParts(parts, {
    directory: opts?.directory,
    attachmentName,
  })

  // Construct the result prompt
  let result: Prompt = []
  result = reconstructPrompt(text, inline)

  // If the result has nothing, say empty text is the default return.
  if (result.length === 0) {
    result.push({ type: "text", content: "", start: 0, end: 0 })
  }

  // If the result has nothing, append images
  if (images.length === 0) return result
  return [...result, ...images]
}
