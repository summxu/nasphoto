const state = {
  items: [],
  total: 0,
  columns: 3,
  gap: 2,
  edge: 6,
  minCell: 110,
  maxColumns: 7,
  cellSize: 0,
  rowHeight: 0,
  rowCount: 0,
  overscan: 3,
  visible: new Map(),
  renderQueued: false,
  initialScrollDone: false,
};

const viewerState = {
  items: [],
  index: -1,
  preloadCache: new Set(),
  exifCache: new Map(),
};

const elements = {
  topbarTitle: document.getElementById("topbar-title"),
  topbarMeta: document.getElementById("topbar-meta"),
  refreshButton: document.getElementById("refresh-button"),
  folderCount: document.getElementById("folder-count"),
  folderCancelButton: document.getElementById("folder-cancel-button"),
  folderDeleteButton: document.getElementById("folder-delete-button"),
  galleryScroller: document.getElementById("gallery-scroller"),
  gallerySpacer: document.getElementById("gallery-spacer"),
  galleryItems: document.getElementById("gallery-items"),
  galleryOverlay: document.getElementById("gallery-overlay"),
  galleryLoading: document.getElementById("gallery-loading"),
  galleryEmpty: document.getElementById("gallery-empty"),
  galleryError: document.getElementById("gallery-error"),
  scrollIndicator: document.getElementById("scroll-indicator"),
  retryButton: document.getElementById("retry-button"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  views: {
    gallery: document.getElementById("view-gallery"),
    folders: document.getElementById("view-folders"),
    portraits: document.getElementById("view-portraits"),
    memories: document.getElementById("view-memories"),
  },
  viewer: document.getElementById("viewer"),
  viewerBackdrop: document.getElementById("viewer-backdrop"),
  viewerStage: document.getElementById("viewer-stage"),
  viewerTrack: null,
  viewerInfo: document.getElementById("viewer-info"),
  viewerDelete: document.getElementById("viewer-delete"),
  viewerClose: document.getElementById("viewer-close"),
  viewerPrev: document.getElementById("viewer-prev"),
  viewerNext: document.getElementById("viewer-next"),
  viewerDeleteSheet: document.getElementById("viewer-delete-sheet"),
  viewerDeleteBackdrop: document.getElementById("viewer-delete-backdrop"),
  viewerDeleteText: document.getElementById("viewer-delete-text"),
  viewerDeleteCancel: document.getElementById("viewer-delete-cancel"),
  viewerDeleteConfirm: document.getElementById("viewer-delete-confirm"),
  exifSheet: document.getElementById("exif-sheet"),
  exifSheetBackdrop: document.getElementById("exif-sheet-backdrop"),
  exifContent: document.getElementById("exif-content"),
};

const normalizeRoutePath = (value) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "/";
  }
  let normalized = raw.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) {
    return "/";
  }
  return `/${segments.join("/")}` || "/";
};

const getRouteInfo = () => {
  const path = normalizeRoutePath(window.location?.pathname || "/");
  const segments = path.split("/").filter(Boolean);
  const ignoreHidden = segments[0] === "all";
  const allowDelete = segments[segments.length - 1] === "admin";
  return { path, ignoreHidden, allowDelete };
};

const routeInfo = getRouteInfo();
window.NasPhotoRoute = routeInfo;

const DEFAULT_PWA_CONFIG = {
  enabled: true,
  offlineCacheDays: 365,
  maxCacheEntries: 500,
};

const VIEWER_BACKDROP_OPACITY = 0.86;
const VIEWER_SWIPE_RATIO = 0.18;
const VIEWER_SWIPE_VELOCITY = 0.6;
const VIEWER_DISMISS_RATIO = 0.18;
const VIEWER_ANIMATE_MS = 260;

const viewerGesture = {
  pointerId: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  startTime: 0,
  mode: null,
  stageWidth: 0,
  stageHeight: 0,
};

const overlayMap = {
  loading: elements.galleryLoading,
  empty: elements.galleryEmpty,
  error: elements.galleryError,
};

let scrollIndicatorTimer = null;
let activeTab = "gallery";
let viewerDeletePending = false;

const toggleElement = (el, show) => {
  if (!el) {
    return;
  }
  el.style.display = show ? "" : "none";
};

const applyRoutePermissions = () => {
  if (!routeInfo.allowDelete) {
    toggleElement(elements.viewerDelete, false);
  }
};

const setTopbarActions = (mode, hasSelection = false) => {
  const allowDelete = routeInfo.allowDelete;
  if (mode === "gallery") {
    toggleElement(elements.refreshButton, false);
    toggleElement(elements.folderCount, false);
    toggleElement(elements.folderCancelButton, false);
    toggleElement(elements.folderDeleteButton, false);
    return;
  }
  if (mode === "folders") {
    toggleElement(elements.refreshButton, false);
    toggleElement(elements.folderCount, true);
    toggleElement(elements.folderCancelButton, false);
    toggleElement(elements.folderDeleteButton, false);
    if (elements.folderDeleteButton) {
      elements.folderDeleteButton.disabled = true;
    }
    return;
  }
  if (mode === "folders-select") {
    toggleElement(elements.refreshButton, false);
    toggleElement(elements.folderCount, false);
    toggleElement(elements.folderCancelButton, allowDelete);
    toggleElement(elements.folderDeleteButton, allowDelete);
    if (elements.folderDeleteButton) {
      elements.folderDeleteButton.disabled = !hasSelection || !allowDelete;
    }
    return;
  }

  toggleElement(elements.refreshButton, false);
  toggleElement(elements.folderCount, false);
  toggleElement(elements.folderCancelButton, false);
  toggleElement(elements.folderDeleteButton, false);
};

window.NasPhotoTopbar = {
  setMeta: (text) => setTopbarMeta(text),
  setTitle: (text) => {
    if (elements.topbarTitle) {
      elements.topbarTitle.textContent = text;
    }
  },
  setTitleHtml: (html) => {
    if (elements.topbarTitle) {
      elements.topbarTitle.innerHTML = html;
    }
  },
  setFolderCount: (countText) => {
    if (elements.folderCount) {
      const value = countText || "";
      elements.folderCount.textContent = value;
      if (value) {
        elements.folderCount.style.display = "";
      } else {
        elements.folderCount.style.display = "none";
      }
    }
  },
  setFolderActionMode: (mode, hasSelection = false) => {
    if (mode === "select") {
      setTopbarActions("folders-select", hasSelection);
    } else if (mode === "default") {
      setTopbarActions("folders");
    }
  },
  isFoldersTab: () => activeTab === "folders",
};

const updateOverlay = (stateName) => {
  elements.galleryOverlay.classList.toggle("is-active", Boolean(stateName));
  Object.values(overlayMap).forEach((node) => {
    node.classList.remove("is-visible");
  });
  if (stateName && overlayMap[stateName]) {
    overlayMap[stateName].classList.add("is-visible");
  }
  if (stateName) {
    hideScrollIndicator();
  }
};

const formatScrollDate = (timeMs) => {
  if (!Number.isFinite(timeMs) || timeMs <= 0) {
    return "未知日期";
  }
  const date = new Date(timeMs);
  if (Number.isNaN(date.getTime())) {
    return "未知日期";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1);
  const day = String(date.getDate());
  return `${year}年${month}月${day}日`;
};

const formatDateTime = (timeMs) => {
  if (!Number.isFinite(timeMs) || timeMs <= 0) {
    return "未知";
  }
  const date = new Date(timeMs);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const formatBytes = (size) => {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
};

const BAIDU_MAP_AK = "2d93281b9c68987df16e8c11e259a735";

const buildBaiduStaticMapUrl = (latitude, longitude) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `https://api.map.baidu.com/staticimage/v2?ak=${BAIDU_MAP_AK}&center=${lng},${lat}&zoom=16&width=640&height=360&markers=${lng},${lat}&markerStyles=l,,red`;
};

const createExifRow = (label, value) => {
  const row = document.createElement("div");
  row.className = "exif-row";
  const name = document.createElement("div");
  name.className = "exif-label";
  name.textContent = label;
  const content = document.createElement("div");
  content.className = "exif-value";
  content.textContent = value ?? "未知";
  row.appendChild(name);
  row.appendChild(content);
  return row;
};

const createExifSection = (title) => {
  const section = document.createElement("div");
  section.className = "exif-section";
  const heading = document.createElement("div");
  heading.className = "exif-section-title";
  heading.textContent = title;
  section.appendChild(heading);
  return section;
};

const setExifLoading = (text) => {
  if (!elements.exifContent) {
    return;
  }
  elements.exifContent.innerHTML = "";
  const section = createExifSection("加载中");
  section.appendChild(createExifRow("状态", text));
  elements.exifContent.appendChild(section);
};

const closeExifSheet = () => {
  if (!elements.exifSheet) {
    return;
  }
  elements.exifSheet.classList.remove("is-visible");
  elements.exifSheet.setAttribute("aria-hidden", "true");
};

const openExifSheet = () => {
  if (!elements.exifSheet) {
    return;
  }
  elements.exifSheet.classList.add("is-visible");
  elements.exifSheet.setAttribute("aria-hidden", "false");
};

const openViewerDeleteSheet = () => {
  if (!elements.viewerDeleteSheet) {
    return;
  }
  elements.viewerDeleteSheet.classList.add("is-visible");
  elements.viewerDeleteSheet.setAttribute("aria-hidden", "false");
};

const closeViewerDeleteSheet = () => {
  if (!elements.viewerDeleteSheet) {
    return;
  }
  elements.viewerDeleteSheet.classList.remove("is-visible");
  elements.viewerDeleteSheet.setAttribute("aria-hidden", "true");
};

const setViewerDeleteText = (text) => {
  if (elements.viewerDeleteText) {
    elements.viewerDeleteText.textContent = text;
  }
};

const setViewerDeleteBusy = (busy) => {
  if (elements.viewerDeleteConfirm) {
    elements.viewerDeleteConfirm.disabled = busy;
  }
  if (elements.viewerDeleteCancel) {
    elements.viewerDeleteCancel.disabled = busy;
  }
};

const renderExifSheet = (data) => {
  if (!elements.exifContent) {
    return;
  }
  elements.exifContent.innerHTML = "";

  const base = createExifSection("基础信息");
  base.appendChild(createExifRow("文件名", data.fileName));
  base.appendChild(createExifRow("类型", data.mediaType));
  base.appendChild(createExifRow("大小", formatBytes(data.sizeBytes)));
  base.appendChild(createExifRow("路径", data.relPath));
  base.appendChild(createExifRow("文件修改", formatDateTime(data.mtimeMs)));
  base.appendChild(createExifRow("文件创建", formatDateTime(data.ctimeMs)));
  base.appendChild(createExifRow("拍摄时间", formatDateTime(data.takenTimeMs)));
  base.appendChild(createExifRow("EXIF时间", formatDateTime(data.exifTimeMs)));
  base.appendChild(createExifRow("媒体创建", formatDateTime(data.mediaCreateTimeMs)));
  elements.exifContent.appendChild(base);

  if (data.gps && Number.isFinite(data.gps.latitude)) {
    const mapSection = createExifSection("地图位置");
    mapSection.appendChild(
      createExifRow(
        "坐标",
        `${data.gps.latitude.toFixed(6)}, ${data.gps.longitude.toFixed(6)}`,
      ),
    );
    if (Number.isFinite(data.gps.altitude)) {
      mapSection.appendChild(createExifRow("海拔", `${data.gps.altitude} m`));
    }
    const map = document.createElement("img");
    map.className = "exif-map";
    map.loading = "lazy";
    map.alt = "地图";
    map.src = buildBaiduStaticMapUrl(data.gps.latitude, data.gps.longitude);
    mapSection.appendChild(map);
    elements.exifContent.appendChild(mapSection);
  }

  const exifEntries = data.exif ? Object.entries(data.exif) : [];
  if (exifEntries.length > 0) {
    const exifSection = createExifSection("EXIF字段");
    exifEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([key, value]) => {
        exifSection.appendChild(createExifRow(key, String(value)));
      });
    elements.exifContent.appendChild(exifSection);
  }
};

const loadExifForCurrent = async () => {
  if (viewerState.index < 0 || viewerState.index >= viewerState.items.length) {
    return;
  }
  const item = viewerState.items[viewerState.index];
  if (!item) {
    return;
  }
  const cached = viewerState.exifCache.get(item.id);
  if (cached) {
    renderExifSheet(cached);
    return;
  }
  setExifLoading("读取中...");
  try {
    const data = await fetchJson(`/api/media/${item.id}/exif`);
    viewerState.exifCache.set(item.id, data);
    renderExifSheet(data);
  } catch (error) {
    console.error(error);
    setExifLoading("读取失败");
  }
};

const hideScrollIndicator = () => {
  if (!elements.scrollIndicator) {
    return;
  }
  elements.scrollIndicator.classList.remove("is-visible");
};

const showScrollIndicator = () => {
  if (!elements.scrollIndicator) {
    return;
  }
  elements.scrollIndicator.classList.add("is-visible");
  if (scrollIndicatorTimer) {
    clearTimeout(scrollIndicatorTimer);
  }
  scrollIndicatorTimer = setTimeout(() => {
    hideScrollIndicator();
  }, 700);
};

const updateScrollIndicator = () => {
  if (
    !elements.scrollIndicator ||
    state.items.length === 0 ||
    state.rowHeight <= 0 ||
    state.columns <= 0
  ) {
    return;
  }
  const scroller = elements.galleryScroller;
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  const anchor = scrollTop + Math.min(120, viewportHeight * 0.2);
  const row = Math.max(0, Math.floor(anchor / state.rowHeight));
  const index = Math.min(state.items.length - 1, row * state.columns);
  const item = state.items[index];
  if (!item) {
    return;
  }
  const label = formatScrollDate(item.timeMs);
  if (elements.scrollIndicator.textContent !== label) {
    elements.scrollIndicator.textContent = label;
  }
  showScrollIndicator();
};

const syncGridMetrics = () => {
  const styles = getComputedStyle(document.documentElement);
  const gap = parseFloat(styles.getPropertyValue("--grid-gap")) || 2;
  const edge = parseFloat(styles.getPropertyValue("--grid-edge")) || 6;
  const minCell = parseFloat(styles.getPropertyValue("--grid-min")) || 110;
  const maxColumns = Math.max(
    2,
    parseInt(styles.getPropertyValue("--grid-max"), 10) || 7,
  );
  state.gap = gap;
  state.edge = edge;
  state.minCell = minCell;
  state.maxColumns = maxColumns;
};

const updateLayout = () => {
  const scroller = elements.galleryScroller;
  if (!scroller) {
    return;
  }
  const shouldStickToBottom = !state.initialScrollDone || isNearBottom();
  syncGridMetrics();
  const width = scroller.clientWidth;
  const usable = Math.max(0, width - state.edge * 2);
  const columns = Math.max(
    2,
    Math.floor((usable + state.gap) / (state.minCell + state.gap)),
  );
  state.columns = Math.min(state.maxColumns, columns);
  const cell = Math.floor(
    (usable - state.gap * (state.columns - 1)) / state.columns,
  );
  state.cellSize = Math.max(64, cell);
  state.rowHeight = state.cellSize + state.gap;
  state.rowCount = Math.ceil(state.items.length / state.columns);

  let totalHeight = 0;
  if (state.rowCount > 0) {
    totalHeight = state.rowCount * state.rowHeight - state.gap + state.edge * 2;
  }
  const contentHeight = Math.max(0, totalHeight);
  const viewportHeight = elements.galleryScroller.clientHeight;
  elements.gallerySpacer.style.height = `calc(100vh - 133px)`;
  elements.galleryItems.style.height = `${contentHeight}px`;
  if (shouldStickToBottom) {
    scrollToBottom();
  }
  scheduleRender(true);
};

const scheduleRender = (force = false) => {
  if (state.renderQueued && !force) {
    return;
  }
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderVisible();
  });
};

const renderVisible = () => {
  if (!elements.galleryScroller) {
    return;
  }
  const scrollTop = elements.galleryScroller.scrollTop;
  const viewportHeight = elements.galleryScroller.clientHeight;
  if (state.rowCount === 0) {
    state.visible.forEach((node) => node.remove());
    state.visible.clear();
    return;
  }

  const startRow = Math.max(0, Math.floor(scrollTop / state.rowHeight) - state.overscan);
  const endRow = Math.min(
    state.rowCount - 1,
    Math.ceil((scrollTop + viewportHeight) / state.rowHeight) + state.overscan,
  );
  const startIndex = startRow * state.columns;
  const endIndex = Math.min(state.items.length, (endRow + 1) * state.columns);

  const nextVisible = new Set();

  for (let index = startIndex; index < endIndex; index += 1) {
    nextVisible.add(index);
    const row = Math.floor(index / state.columns);
    const col = index % state.columns;
    const x = state.edge + col * (state.cellSize + state.gap);
    const y = state.edge + row * (state.cellSize + state.gap);

    let tile = state.visible.get(index);
    if (!tile) {
      tile = createTile(index);
      state.visible.set(index, tile);
      elements.galleryItems.appendChild(tile);
    }

    tile.style.width = `${state.cellSize}px`;
    tile.style.height = `${state.cellSize}px`;
    tile.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  for (const [index, node] of state.visible.entries()) {
    if (!nextVisible.has(index)) {
      node.remove();
      state.visible.delete(index);
    }
  }
};

const createTile = (index) => {
  const item = state.items[index];
  const button = document.createElement("button");
  button.type = "button";
  button.className = "media-tile";
  button.dataset.index = String(index);
  button.setAttribute("aria-label", item.mediaType === "video" ? "视频" : "照片");

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.src = item.thumbUrl;
  img.addEventListener("load", () => {
    img.classList.add("is-loaded");
  });
  button.appendChild(img);

  if (item.mediaType === "video") {
    const badge = document.createElement("span");
    badge.className = "tile-badge";
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6l10 6-10 6z"/></svg>视频';
    button.appendChild(badge);
  }

  return button;
};

const getMaxScrollTop = () => {
  const scroller = elements.galleryScroller;
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
};

const isNearBottom = () => {
  const scroller = elements.galleryScroller;
  return getMaxScrollTop() - scroller.scrollTop <= 2;
};

const scrollToBottom = () => {
  elements.galleryScroller.scrollTop = getMaxScrollTop();
};

const setTopbarMeta = (text) => {
  elements.topbarMeta.textContent = text;
};

const fetchJson = async (url, options = {}) => {
  const headers = new Headers(options.headers || {});
  headers.set("X-Nasphoto-Route", getRouteInfo().path);
  const response = await fetch(url, { cache: "no-store", ...options, headers });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
};

const getViewerStageSize = () => ({
  width: elements.viewerStage.clientWidth || window.innerWidth,
  height: elements.viewerStage.clientHeight || window.innerHeight,
});

const getViewerTrack = () =>
  elements.viewerTrack || elements.viewerStage.querySelector(".viewer-track");

const animateViewerTrackTo = (targetX, onDone) => {
  const track = getViewerTrack();
  if (!track) {
    onDone?.();
    return;
  }
  track.classList.remove("is-dragging");
  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    track.removeEventListener("transitionend", finish);
    onDone?.();
  };
  track.addEventListener("transitionend", finish, { once: true });
  track.style.transform = `translate3d(${targetX}px, 0, 0)`;
  setTimeout(finish, VIEWER_ANIMATE_MS);
};

const updateGalleryAfterDelete = () => {
  if (activeTab !== "gallery") {
    return;
  }
  state.visible.forEach((node) => node.remove());
  state.visible.clear();
  state.total = state.items.length;
  if (state.items.length === 0) {
    updateOverlay("empty");
    setTopbarMeta("暂无照片");
  } else {
    updateOverlay(null);
    setTopbarMeta(`共 ${state.items.length} 张`);
  }
  updateLayout();
};

const deleteCurrentViewerItem = async () => {
  if (viewerDeletePending) {
    return;
  }
  const index = viewerState.index;
  if (index < 0 || index >= viewerState.items.length) {
    return;
  }
  const item = viewerState.items[index];
  if (!item || !Number.isFinite(item.id)) {
    return;
  }
  const rootId = Number.isFinite(item.rootId) ? item.rootId : null;
  if (rootId === null) {
    setViewerDeleteText("无法删除该文件");
    return;
  }
  viewerDeletePending = true;
  setViewerDeleteBusy(true);
  setViewerDeleteText("正在删除...");
  try {
    await fetchJson("/api/folders/items", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootId, mediaIds: [item.id] }),
    });
  } catch (error) {
    console.error(error);
    setViewerDeleteText("删除失败，请重试");
    viewerDeletePending = false;
    setViewerDeleteBusy(false);
    openViewerDeleteSheet();
    return;
  }

  closeViewerDeleteSheet();

  const hasNext = index < viewerState.items.length - 1;
  const hasPrev = index > 0;
  const finalize = () => {
    viewerDeletePending = false;
    setViewerDeleteBusy(false);
  };

  if (!hasNext && !hasPrev) {
    viewerState.items.splice(index, 1);
    if (viewerState.items === state.items) {
      updateGalleryAfterDelete();
    } else if (activeTab === "folders") {
      window.FolderView?.refresh?.();
    }
    closeViewer();
    finalize();
    return;
  }

  const width = getViewerStageSize().width;
  if (hasNext) {
    animateViewerTrackTo(-2 * width, () => {
      viewerState.items.splice(index, 1);
      viewerState.index = Math.min(index, viewerState.items.length - 1);
      if (viewerState.items === state.items) {
        updateGalleryAfterDelete();
      } else if (activeTab === "folders") {
        window.FolderView?.refresh?.();
      }
      renderViewer();
      finalize();
    });
    return;
  }

  animateViewerTrackTo(0, () => {
    viewerState.items.splice(index, 1);
    viewerState.index = Math.max(index - 1, 0);
    if (viewerState.items === state.items) {
      updateGalleryAfterDelete();
    } else if (activeTab === "folders") {
      window.FolderView?.refresh?.();
    }
    renderViewer();
    finalize();
  });
};

const openViewerDeletePrompt = () => {
  if (viewerDeletePending) {
    return;
  }
  if (viewerState.index < 0 || viewerState.index >= viewerState.items.length) {
    return;
  }
  const item = viewerState.items[viewerState.index];
  if (item?.fileName) {
    setViewerDeleteText(`确认删除 ${item.fileName}？`);
  } else {
    setViewerDeleteText("确认删除当前文件？");
  }
  setViewerDeleteBusy(false);
  openViewerDeleteSheet();
};

const loadMedia = async () => {
  updateOverlay("loading");
  state.items = [];
  state.total = 0;
  state.visible.forEach((node) => node.remove());
  state.visible.clear();
  viewerState.exifCache.clear();
  state.initialScrollDone = false;
  updateLayout();

  let offset = 0;
  const limit = 500;
  let total = Infinity;

  try {
    while (offset < total) {
      const data = await fetchJson(`/api/media?limit=${limit}&offset=${offset}`);
      const items = Array.isArray(data.items) ? data.items : [];
      if (total === Infinity) {
        total = Number.isFinite(data.total) ? data.total : items.length;
      }
      state.total = total;
      state.items.push(...items);
      offset += items.length;

      if (items.length === 0) {
        break;
      }

      updateLayout();
    }

    if (state.items.length === 0) {
      updateOverlay("empty");
      setTopbarMeta("暂无照片");
      return;
    }

    updateOverlay(null);
    setTopbarMeta(`共 ${state.items.length} 张`);
    updateLayout();
    if (!state.initialScrollDone) {
      requestAnimationFrame(() => {
        scrollToBottom();
        state.initialScrollDone = true;
      });
    }
  } catch (error) {
    console.error(error);
    updateOverlay("error");
    setTopbarMeta("加载失败");
  }
};

const setActiveTab = (tabName) => {
  activeTab = tabName;
  elements.tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  Object.entries(elements.views).forEach(([name, view]) => {
    view.classList.toggle("is-active", name === tabName);
  });

  const titles = {
    gallery: "图库",
    portraits: "人像",
    memories: "回忆",
  };
  if (tabName === "gallery") {
    elements.topbarTitle.textContent = titles.gallery;
    setTopbarActions("gallery");
    if (state.items.length > 0) {
      setTopbarMeta(`共 ${state.items.length} 张`);
    }
  } else if (tabName === "folders") {
    setTopbarActions("folders");
    setTopbarMeta("");
    hideScrollIndicator();
    window.FolderView?.activate?.();
  } else {
    elements.topbarTitle.textContent = titles[tabName] || "图库";
    setTopbarActions("hidden");
    setTopbarMeta("");
    hideScrollIndicator();
  }
};

const openViewer = (items, index) => {
  if (!Array.isArray(items) || index < 0 || index >= items.length) {
    return;
  }
  viewerState.items = items;
  viewerState.index = index;
  elements.viewer.classList.add("is-visible");
  elements.viewer.setAttribute("aria-hidden", "false");
  document.body.classList.add("viewer-open");
  closeExifSheet();
  renderViewer();
};

const closeViewer = () => {
  elements.viewer.classList.remove("is-visible");
  elements.viewer.setAttribute("aria-hidden", "true");
  elements.viewerStage.innerHTML = "";
  elements.viewerTrack = null;
  document.body.classList.remove("viewer-open");
  viewerState.index = -1;
  viewerState.items = [];
  closeExifSheet();
  closeViewerDeleteSheet();
  resetViewerTransforms({ keepBackdrop: true });
};

const setViewerBackdropOpacity = (value) => {
  elements.viewerBackdrop.style.opacity = String(value);
};

const resetViewerTransforms = (options = {}) => {
  elements.viewerStage.classList.remove("is-dragging");
  elements.viewerStage.style.transform = "";
  const track =
    elements.viewerTrack || elements.viewerStage.querySelector(".viewer-track");
  if (track) {
    track.classList.remove("is-dragging");
    track.style.transform = "";
  }
  if (!options.keepBackdrop) {
    setViewerBackdropOpacity(VIEWER_BACKDROP_OPACITY);
  }
};

const createViewerMedia = (item) => {
  if (item.mediaType === "video") {
    const wrapper = document.createElement("div");
    wrapper.className = "viewer-media";

    const thumb = document.createElement("img");
    thumb.className = "viewer-thumb";
    thumb.alt = "";
    thumb.draggable = false;
    thumb.src = item.thumbUrl;

    const video = document.createElement("video");
    video.className = "viewer-video";
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.autoplay = true;
    video.loop = true;
    video.addEventListener("playing", () => {
      wrapper.classList.add("is-playing");
    });
    video.src = item.originalUrl;

    wrapper.appendChild(thumb);
    wrapper.appendChild(video);
    wrapper.addEventListener("click", () => {
      if (wrapper.classList.contains("is-playing")) {
        return;
      }
      video.play().catch(() => {});
    });
    return wrapper;
  }

  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.src = item.originalUrl;
  return img;
};

const createViewerSlide = (index) => {
  const slide = document.createElement("div");
  slide.className = "viewer-slide";
  if (index < 0 || index >= viewerState.items.length) {
    slide.classList.add("is-empty");
    return slide;
  }
  const item = viewerState.items[index];
  slide.appendChild(createViewerMedia(item));
  return slide;
};

const renderViewer = () => {
  const index = viewerState.index;
  const item = viewerState.items[index];
  if (!item) {
    return;
  }

  elements.viewerStage.innerHTML = "";
  const track = document.createElement("div");
  track.className = "viewer-track";
  track.appendChild(createViewerSlide(index - 1));
  track.appendChild(createViewerSlide(index));
  track.appendChild(createViewerSlide(index + 1));
  elements.viewerStage.appendChild(track);
  elements.viewerTrack = track;

  elements.viewerPrev.disabled = index <= 0;
  elements.viewerNext.disabled = index >= viewerState.items.length - 1;

  resetViewerTransforms();
  preloadNearby(index);
  if (elements.exifSheet?.classList.contains("is-visible")) {
    loadExifForCurrent();
  }
};

const preloadNearby = (index) => {
  for (let offset = -3; offset <= 3; offset += 1) {
    if (offset === 0) {
      continue;
    }
    const target = index + offset;
    if (target < 0 || target >= viewerState.items.length) {
      continue;
    }
    const item = viewerState.items[target];
    if (item.mediaType !== "image") {
      continue;
    }
    if (viewerState.preloadCache.has(item.originalUrl)) {
      continue;
    }
    const img = new Image();
    img.src = item.originalUrl;
    viewerState.preloadCache.add(item.originalUrl);
  }
};

const showPrev = () => {
  if (viewerState.index > 0) {
    viewerState.index -= 1;
    renderViewer();
  }
};

const showNext = () => {
  if (viewerState.index < viewerState.items.length - 1) {
    viewerState.index += 1;
    renderViewer();
  }
};

const setupViewerGestures = () => {
  const getStageSize = () => ({
    width: elements.viewerStage.clientWidth || window.innerWidth,
    height: elements.viewerStage.clientHeight || window.innerHeight,
  });

  const getTrack = () =>
    elements.viewerTrack || elements.viewerStage.querySelector(".viewer-track");

  const setTrackOffset = (offsetX, dragging = false) => {
    const track = getTrack();
    if (!track) {
      return;
    }
    const width = viewerGesture.stageWidth || getStageSize().width;
    const base = -width;
    track.classList.toggle("is-dragging", dragging);
    track.style.transform = `translate3d(${base + offsetX}px, 0, 0)`;
  };

  const animateTrackTo = (targetX, onDone) => {
    const track = getTrack();
    if (!track) {
      onDone?.();
      return;
    }
    track.classList.remove("is-dragging");
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      track.removeEventListener("transitionend", finish);
      onDone?.();
    };
    track.addEventListener("transitionend", finish, { once: true });
    track.style.transform = `translate3d(${targetX}px, 0, 0)`;
    setTimeout(finish, 260);
  };

  const resetDrag = () => {
    viewerGesture.pointerId = null;
    viewerGesture.mode = null;
    elements.viewerStage.classList.remove("is-dragging");
  };

  const onPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (viewerState.index === -1) {
      return;
    }
    const { width, height } = getStageSize();
    viewerGesture.pointerId = event.pointerId;
    viewerGesture.startX = event.clientX;
    viewerGesture.startY = event.clientY;
    viewerGesture.lastX = event.clientX;
    viewerGesture.lastY = event.clientY;
    viewerGesture.startTime = performance.now();
    viewerGesture.mode = null;
    viewerGesture.stageWidth = width;
    viewerGesture.stageHeight = height;
    elements.viewerStage.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (viewerGesture.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - viewerGesture.startX;
    const deltaY = event.clientY - viewerGesture.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (!viewerGesture.mode) {
      if (absX < 6 && absY < 6) {
        return;
      }
      if (absX > absY * 1.1) {
        viewerGesture.mode = "horizontal";
        elements.viewerStage.classList.add("is-dragging");
      } else if (deltaY > 0 && absY > absX * 1.1) {
        viewerGesture.mode = "vertical";
        elements.viewerStage.classList.add("is-dragging");
      } else {
        return;
      }
    }

    event.preventDefault();

    if (viewerGesture.mode === "horizontal") {
      const atStart = viewerState.index <= 0;
      const atEnd = viewerState.index >= viewerState.items.length - 1;
      let offsetX = deltaX;
      if ((atStart && deltaX > 0) || (atEnd && deltaX < 0)) {
        offsetX = deltaX * 0.35;
      }
      setTrackOffset(offsetX, true);
      elements.viewerStage.style.transform = "";
      setViewerBackdropOpacity(VIEWER_BACKDROP_OPACITY);
    } else {
      const clamped = Math.max(0, deltaY);
      const height = viewerGesture.stageHeight || getStageSize().height;
      const progress = Math.min(1, clamped / (height * 0.9));
      const scale = 1 - progress * 0.08;
      elements.viewerStage.style.transform = `translate3d(0, ${clamped}px, 0) scale(${scale})`;
      setViewerBackdropOpacity(VIEWER_BACKDROP_OPACITY * (1 - progress));
      setTrackOffset(0, false);
    }

    viewerGesture.lastX = event.clientX;
    viewerGesture.lastY = event.clientY;
  };

  const onPointerUp = (event) => {
    if (viewerGesture.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - viewerGesture.startX;
    const deltaY = event.clientY - viewerGesture.startY;
    const elapsed = performance.now() - viewerGesture.startTime;
    const width = viewerGesture.stageWidth || getStageSize().width;
    const height = viewerGesture.stageHeight || getStageSize().height;
    const velocityX = deltaX / Math.max(elapsed, 1);
    const velocityY = deltaY / Math.max(elapsed, 1);

    if (viewerGesture.mode === "horizontal") {
      const threshold = width * VIEWER_SWIPE_RATIO;
      const atStart = viewerState.index <= 0;
      const atEnd = viewerState.index >= viewerState.items.length - 1;

      if ((deltaX > threshold || velocityX > VIEWER_SWIPE_VELOCITY) && !atStart) {
        animateTrackTo(0, () => {
          viewerState.index -= 1;
          renderViewer();
        });
      } else if (
        (deltaX < -threshold || velocityX < -VIEWER_SWIPE_VELOCITY) &&
        !atEnd
      ) {
        animateTrackTo(-2 * width, () => {
          viewerState.index += 1;
          renderViewer();
        });
      } else {
        animateTrackTo(-width);
      }
    } else if (viewerGesture.mode === "vertical") {
      const dismissThreshold = height * VIEWER_DISMISS_RATIO;
      if (deltaY > dismissThreshold || velocityY > VIEWER_SWIPE_VELOCITY) {
        elements.viewerStage.classList.remove("is-dragging");
        elements.viewerStage.style.transform = `translate3d(0, ${height}px, 0) scale(0.96)`;
        setViewerBackdropOpacity(0);
        setTimeout(() => {
          closeViewer();
        }, 200);
      } else {
        elements.viewerStage.classList.remove("is-dragging");
        elements.viewerStage.style.transform = "";
        setViewerBackdropOpacity(VIEWER_BACKDROP_OPACITY);
      }
    }

    try {
      elements.viewerStage.releasePointerCapture(event.pointerId);
    } catch (error) {
      console.warn("Pointer capture release failed", error);
    }
    resetDrag();
  };

  const onPointerCancel = (event) => {
    if (viewerGesture.pointerId !== event.pointerId) {
      return;
    }
    try {
      elements.viewerStage.releasePointerCapture(event.pointerId);
    } catch (error) {
      console.warn("Pointer capture release failed", error);
    }
    resetViewerTransforms();
    resetDrag();
  };

  elements.viewerStage.addEventListener("pointerdown", onPointerDown);
  elements.viewerStage.addEventListener("pointermove", onPointerMove, {
    passive: false,
  });
  elements.viewerStage.addEventListener("pointerup", onPointerUp);
  elements.viewerStage.addEventListener("pointercancel", onPointerCancel);
};

const setupServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const sendConfig = async () => {
      try {
        const config = await fetchJson("/api/pwa-config");
        const payload = { ...DEFAULT_PWA_CONFIG, ...config };
        const target =
          registration.active || registration.waiting || registration.installing;
        target?.postMessage({ type: "PWA_CONFIG", payload });
      } catch (error) {
        console.warn("PWA config fetch failed", error);
      }
    };

    if (navigator.serviceWorker.controller) {
      await sendConfig();
    } else {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          sendConfig();
        },
        { once: true },
      );
    }
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
};

const setupEvents = () => {
  elements.galleryScroller.addEventListener("scroll", () => {
    scheduleRender();
    updateScrollIndicator();
  });
  window.addEventListener("resize", updateLayout);

  elements.galleryItems.addEventListener("click", (event) => {
    const target = event.target.closest(".media-tile");
    if (!target) {
      return;
    }
    const index = Number(target.dataset.index);
    if (Number.isFinite(index)) {
      openViewer(state.items, index);
    }
  });

  elements.viewerClose.addEventListener("click", closeViewer);
  elements.viewerBackdrop.addEventListener("click", closeViewer);
  elements.viewerPrev.addEventListener("click", showPrev);
  elements.viewerNext.addEventListener("click", showNext);
  elements.viewerInfo.addEventListener("click", () => {
    if (viewerState.index === -1) {
      return;
    }
    if (elements.exifSheet?.classList.contains("is-visible")) {
      closeExifSheet();
      return;
    }
    openExifSheet();
    loadExifForCurrent();
  });
  elements.viewerDelete?.addEventListener("click", openViewerDeletePrompt);
  elements.exifSheetBackdrop.addEventListener("click", closeExifSheet);
  elements.viewerDeleteBackdrop?.addEventListener("click", closeViewerDeleteSheet);
  elements.viewerDeleteCancel?.addEventListener("click", closeViewerDeleteSheet);
  elements.viewerDeleteConfirm?.addEventListener("click", deleteCurrentViewerItem);

  document.addEventListener("keydown", (event) => {
    if (viewerState.index === -1) {
      return;
    }
    if (event.key === "Escape") {
      if (elements.exifSheet?.classList.contains("is-visible")) {
        closeExifSheet();
      } else {
        closeViewer();
      }
    }
    if (event.key === "ArrowLeft") {
      showPrev();
    }
    if (event.key === "ArrowRight") {
      showNext();
    }
  });

  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      if (name) {
        setActiveTab(name);
      }
    });
  });

  elements.retryButton.addEventListener("click", loadMedia);
  elements.refreshButton.addEventListener("click", () => {
    if (activeTab === "folders" && window.FolderView?.refresh) {
      window.FolderView.refresh();
      return;
    }
    if (activeTab === "gallery") {
      loadMedia();
    }
  });

  setupViewerGestures();
};

const init = async () => {
  setActiveTab("gallery");
  updateLayout();
  setupEvents();
  setupServiceWorker();
  applyRoutePermissions();
  await loadMedia();
};

window.NasPhotoViewer = {
  open: (items, index) => openViewer(items, index),
  close: () => closeViewer(),
  isOpen: () => viewerState.index !== -1,
};

init();
