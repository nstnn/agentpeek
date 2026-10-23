export const DIVIDER_WIDTH = 5
const SIDEBAR_MIN = 170
const SIDEBAR_MAX = 320
const LIST_MIN = 280
const DETAIL_MIN = 320
export const SIDEBAR_RAIL_WIDTH = 56

/** Capacity follows the visible navigation, including the user's sidebar width. */
export function layoutCapacity(
  width: number,
  sizes: PaneSizes,
  collapsed: boolean,
  split: boolean
) {
  const sidebar = collapsed
    ? SIDEBAR_RAIL_WIDTH
    : clamp(sizes.sidebar ?? 190, SIDEBAR_MIN, SIDEBAR_MAX)
  return {
    narrow:
      width <
      sidebar +
        (split ? 2 * DETAIL_MIN : LIST_MIN + DETAIL_MIN) +
        (collapsed ? 1 : 2) * DIVIDER_WIDTH,
    roomy: width >= sidebar + LIST_MIN + 2 * DETAIL_MIN + (collapsed ? 2 : 3) * DIVIDER_WIDTH
  }
}

export interface PaneSizes {
  sidebar?: number
  singleList?: number
  splitList?: number
  splitRatio?: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)))
}

export function paneLayout(
  width: number,
  sizes: PaneSizes,
  visible: {
    sidebar: boolean
    list: boolean
    details: number
    split: boolean
    narrow: boolean
    collapsed?: boolean
  }
) {
  const { sidebar, list, details, split } = visible
  const dividers = Number(sidebar && !visible.collapsed) + Number(list) + details - 1
  const available = width - Math.max(0, dividers) * DIVIDER_WIDTH
  const sidebarMax = Math.min(SIDEBAR_MAX, available - (list ? LIST_MIN : 0) - details * DETAIL_MIN)
  const sidebarWidth = visible.collapsed
    ? SIDEBAR_RAIL_WIDTH
    : sidebar
      ? clamp(sizes.sidebar ?? 190, SIDEBAR_MIN, sidebarMax)
      : 0
  const listMax = available - sidebarWidth - details * DETAIL_MIN
  const listWidth = list
    ? details
      ? clamp(
          (split ? sizes.splitList : sizes.singleList) ?? (split ? 300 : 360),
          LIST_MIN,
          listMax
        )
      : available - sidebarWidth
    : 0
  const detailSpace = available - sidebarWidth - listWidth
  const mainWidth =
    details === 2
      ? clamp(detailSpace * (sizes.splitRatio ?? 0.5), DETAIL_MIN, detailSpace - DETAIL_MIN)
      : detailSpace
  return {
    sidebar: sidebarWidth,
    list: listWidth,
    main: mainWidth,
    second: details === 2 ? detailSpace - mainWidth : 0,
    sidebarMin: SIDEBAR_MIN,
    sidebarMax: Math.max(SIDEBAR_MIN, sidebarMax),
    listMin: LIST_MIN,
    listMax: Math.max(LIST_MIN, listMax),
    detailMin: DETAIL_MIN,
    mainMax: Math.max(DETAIL_MIN, detailSpace - DETAIL_MIN)
  }
}
