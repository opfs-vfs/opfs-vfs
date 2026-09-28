// Adapted from frachter-app/opfs-vfs bash-console at 4d881496, at the owner’s request.
function getRuntimeAssetTargetUrl(target: EventTarget | null) {
  if (!target || typeof target !== 'object') {
    return null;
  }

  if ('src' in target && typeof target.src === 'string' && target.src.length > 0) {
    return target.src;
  }

  if ('href' in target && typeof target.href === 'string' && target.href.length > 0) {
    return target.href;
  }

  return null;
}

function isAiRuntimeMemoryError(error: unknown) {
  if (error instanceof Error) {
    return error.message.includes('memory access out of bounds');
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.length > 0
  ) {
    return error.message.includes('memory access out of bounds');
  }

  return false;
}

export function formatAiRuntimeError(error: unknown) {
  if (isAiRuntimeMemoryError(error)) {
    return 'The local Gemma runtime crashed while loading the model. This usually points to a WebGPU compatibility issue or insufficient available memory for the current backend.';
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof ErrorEvent !== 'undefined' && error instanceof ErrorEvent) {
    if (error.error instanceof Error) {
      return error.error.message;
    }

    if (typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
  }

  if (typeof Event !== 'undefined' && error instanceof Event) {
    const assetUrl = getRuntimeAssetTargetUrl(error.target) ?? getRuntimeAssetTargetUrl(error.currentTarget);
    return assetUrl
      ? `Failed to load a local AI runtime asset: ${assetUrl}`
      : 'Failed to load a local AI runtime asset.';
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.length > 0
  ) {
    return error.message;
  }

  return String(error);
}
