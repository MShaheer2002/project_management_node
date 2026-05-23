export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export function clampListLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT) {
  if (!limit || Number.isNaN(limit)) {
    return fallback;
  }

  return Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
}

export function slicePage<T>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;

  return {
    items: pageItems,
    hasMore,
  };
}
