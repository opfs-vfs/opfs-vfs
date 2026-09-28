// Adapted from frachter-app/opfs-vfs bash-console at 4d881496, at the owner’s request.
const GEMMA_OUTPUT_BOUNDARY_MARKERS = [
  '<turn|>',
  '<|turn>',
  '</start_of_turn>',
  '<end_of_turn>',
  '</end_of_turn>',
  '<start_of_turn>user',
  '<start_of_turn>model',
  '<start_of_turn>',
  '<eos>',
  '<|endoftext|>',
] as const;

function stripLeadingModelTurnPrefix(text: string) {
  return text.replace(/^\s*(?:(?:<\|turn>model|<start_of_turn>model|<\/start_of_turn>)\s*)+/, '');
}

function findFirstBoundaryIndex(text: string) {
  let firstBoundaryIndex = -1;

  for (const marker of GEMMA_OUTPUT_BOUNDARY_MARKERS) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
      continue;
    }

    if (firstBoundaryIndex === -1 || markerIndex < firstBoundaryIndex) {
      firstBoundaryIndex = markerIndex;
    }
  }

  return firstBoundaryIndex;
}

function stripTrailingPartialBoundary(text: string) {
  let trailingPartialLength = 0;

  for (const marker of GEMMA_OUTPUT_BOUNDARY_MARKERS) {
    const longestCandidateLength = Math.min(marker.length - 1, text.length);

    for (let candidateLength = longestCandidateLength; candidateLength > trailingPartialLength; candidateLength -= 1) {
      if (text.endsWith(marker.slice(0, candidateLength))) {
        trailingPartialLength = candidateLength;
        break;
      }
    }
  }

  return trailingPartialLength > 0 ? text.slice(0, -trailingPartialLength) : text;
}

export function sanitizeGemmaChatOutput(rawText: string) {
  let sanitizedText = stripLeadingModelTurnPrefix(rawText.replace(/\r\n?/g, '\n'));
  // Some runtimes return a private thought channel even without thinking enabled.
  if (sanitizedText.trimStart().startsWith('<|channel>thought')) {
    const end = sanitizedText.indexOf('<channel|>');
    if (end < 0) return '';
    sanitizedText = sanitizedText.slice(end + '<channel|>'.length);
  }
  const boundaryIndex = findFirstBoundaryIndex(sanitizedText);

  if (boundaryIndex !== -1) {
    sanitizedText = sanitizedText.slice(0, boundaryIndex);
  } else {
    sanitizedText = stripTrailingPartialBoundary(sanitizedText);
  }

  return sanitizedText.trim();
}
