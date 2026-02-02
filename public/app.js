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
  viewerIndex: -1,
  preloadCache: new Set(),
  initialScrollDone: false,
};

const elements = {
  topbarTitle: document.getElementById("topbar-title"),
  topbarMeta: document.getElementById("topbar-meta"),
  refreshButton: document.getElementById("refresh-button"),
  galleryScroller: document.getElementById("gallery-scroller"),
  gallerySpacer: document.getElementById("gallery-spacer"),
  galleryItems: document.getElementById("gallery-items"),
  galleryOverlay: document.getElementById("gallery-overlay"),
  galleryLoading: document.getElementById("gallery-loading"),
  galleryEmpty: document.getElementById("gallery-empty"),
  galleryError: document.getElementById("gallery-error"),
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
  viewerClose: document.getElementById("viewer-close"),
  viewerPrev: document.getElementById("viewer-prev"),
  viewerNext: document.getElementById("viewer-next"),
};

const DEFAULT_PWA_CONFIG = {
  enabled: true,
  offlineCacheDays: 365,
  maxCacheEntries: 500,
};

const VIEWER_BACKDROP_OPACITY = 0.86;
const VIEWER_SWIPE_RATIO = 0.18;
const VIEWER_SWIPE_VELOCITY = 0.6;
const VIEWER_DISMISS_RATIO = 0.18;

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

const updateOverlay = (stateName) => {
  elements.galleryOverlay.classList.toggle("is-active", Boolean(stateName));
  Object.values(overlayMap).forEach((node) => {
    node.classList.remove("is-visible");
  });
  if (stateName && overlayMap[stateName]) {
    overlayMap[stateName].classList.add("is-visible");
  }
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
  elements.gallerySpacer.style.height = `calc(100vh - 133px)`;
  elements.galleryItems.style.height = `${Math.max(0, totalHeight)}px`;
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

const scrollToBottom = () => {
  const totalHeight = elements.gallerySpacer.offsetHeight;
  const viewportHeight = elements.galleryScroller.clientHeight;
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  elements.galleryScroller.scrollTop = maxScroll;
};

const setTopbarMeta = (text) => {
  elements.topbarMeta.textContent = text;
};

const fetchJson = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
};

const loadMedia = async () => {
  updateOverlay("loading");
  state.items = [];
  state.total = 0;
  state.visible.forEach((node) => node.remove());
  state.visible.clear();
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
    folders: "文件夹",
    portraits: "人像",
    memories: "回忆",
  };
  elements.topbarTitle.textContent = titles[tabName] || "图库";
  if (tabName === "gallery") {
    if (state.items.length > 0) {
      setTopbarMeta(`共 ${state.items.length} 张`);
    }
  } else {
    setTopbarMeta("");
  }
};

const openViewer = (index) => {
  if (index < 0 || index >= state.items.length) {
    return;
  }
  state.viewerIndex = index;
  elements.viewer.classList.add("is-visible");
  elements.viewer.setAttribute("aria-hidden", "false");
  document.body.classList.add("viewer-open");
  renderViewer();
};

const closeViewer = () => {
  elements.viewer.classList.remove("is-visible");
  elements.viewer.setAttribute("aria-hidden", "true");
  elements.viewerStage.innerHTML = "";
  elements.viewerTrack = null;
  document.body.classList.remove("viewer-open");
  state.viewerIndex = -1;
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
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = item.originalUrl;
    return video;
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
  if (index < 0 || index >= state.items.length) {
    slide.classList.add("is-empty");
    return slide;
  }
  const item = state.items[index];
  slide.appendChild(createViewerMedia(item));
  return slide;
};

const renderViewer = () => {
  const index = state.viewerIndex;
  const item = state.items[index];
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
  elements.viewerNext.disabled = index >= state.items.length - 1;

  resetViewerTransforms();
  preloadNearby(index);
};

const preloadNearby = (index) => {
  for (let offset = -3; offset <= 3; offset += 1) {
    if (offset === 0) {
      continue;
    }
    const target = index + offset;
    if (target < 0 || target >= state.items.length) {
      continue;
    }
    const item = state.items[target];
    if (item.mediaType !== "image") {
      continue;
    }
    if (state.preloadCache.has(item.originalUrl)) {
      continue;
    }
    const img = new Image();
    img.src = item.originalUrl;
    state.preloadCache.add(item.originalUrl);
  }
};

const showPrev = () => {
  if (state.viewerIndex > 0) {
    state.viewerIndex -= 1;
    renderViewer();
  }
};

const showNext = () => {
  if (state.viewerIndex < state.items.length - 1) {
    state.viewerIndex += 1;
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
    if (state.viewerIndex === -1) {
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
      const atStart = state.viewerIndex <= 0;
      const atEnd = state.viewerIndex >= state.items.length - 1;
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
      const atStart = state.viewerIndex <= 0;
      const atEnd = state.viewerIndex >= state.items.length - 1;

      if ((deltaX > threshold || velocityX > VIEWER_SWIPE_VELOCITY) && !atStart) {
        animateTrackTo(0, () => {
          state.viewerIndex -= 1;
          renderViewer();
        });
      } else if (
        (deltaX < -threshold || velocityX < -VIEWER_SWIPE_VELOCITY) &&
        !atEnd
      ) {
        animateTrackTo(-2 * width, () => {
          state.viewerIndex += 1;
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
  elements.galleryScroller.addEventListener("scroll", () => scheduleRender());
  window.addEventListener("resize", updateLayout);

  elements.galleryItems.addEventListener("click", (event) => {
    const target = event.target.closest(".media-tile");
    if (!target) {
      return;
    }
    const index = Number(target.dataset.index);
    if (Number.isFinite(index)) {
      openViewer(index);
    }
  });

  elements.viewerClose.addEventListener("click", closeViewer);
  elements.viewerBackdrop.addEventListener("click", closeViewer);
  elements.viewerPrev.addEventListener("click", showPrev);
  elements.viewerNext.addEventListener("click", showNext);

  document.addEventListener("keydown", (event) => {
    if (state.viewerIndex === -1) {
      return;
    }
    if (event.key === "Escape") {
      closeViewer();
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
  elements.refreshButton.addEventListener("click", loadMedia);

  setupViewerGestures();
};

const init = async () => {
  setActiveTab("gallery");
  updateLayout();
  setupEvents();
  setupServiceWorker();
  await loadMedia();
};

init();
