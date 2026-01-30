const state = {
  items: [],
  total: 0,
  columns: 3,
  gap: 2,
  edge: 6,
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
  viewerClose: document.getElementById("viewer-close"),
  viewerPrev: document.getElementById("viewer-prev"),
  viewerNext: document.getElementById("viewer-next"),
};

const DEFAULT_PWA_CONFIG = {
  enabled: true,
  offlineCacheDays: 365,
  maxCacheEntries: 500,
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
  state.gap = gap;
  state.edge = edge;
};

const updateLayout = () => {
  const scroller = elements.galleryScroller;
  if (!scroller) {
    return;
  }
  syncGridMetrics();
  const width = scroller.clientWidth;
  const usable = Math.max(0, width - state.edge * 2);
  const cell = Math.floor((usable - state.gap * (state.columns - 1)) / state.columns);
  state.cellSize = Math.max(64, cell);
  state.rowHeight = state.cellSize + state.gap;
  state.rowCount = Math.ceil(state.items.length / state.columns);

  let totalHeight = 0;
  if (state.rowCount > 0) {
    totalHeight = state.rowCount * state.rowHeight - state.gap + state.edge * 2;
  }
  elements.gallerySpacer.style.height = `${Math.max(0, totalHeight)}px`;
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
  document.body.classList.remove("viewer-open");
  state.viewerIndex = -1;
};

const renderViewer = () => {
  const index = state.viewerIndex;
  const item = state.items[index];
  if (!item) {
    return;
  }

  elements.viewerStage.innerHTML = "";

  if (item.mediaType === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = item.originalUrl;
    elements.viewerStage.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.alt = "";
    img.src = item.originalUrl;
    elements.viewerStage.appendChild(img);
  }

  elements.viewerPrev.disabled = index <= 0;
  elements.viewerNext.disabled = index >= state.items.length - 1;

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
  let startX = 0;
  let startY = 0;
  let pointerId = null;

  const onPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    elements.viewerStage.setPointerCapture(pointerId);
  };

  const onPointerUp = (event) => {
    if (pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    pointerId = null;

    if (Math.abs(deltaX) < 40 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) {
      return;
    }

    if (deltaX < 0) {
      showNext();
    } else {
      showPrev();
    }
  };

  elements.viewerStage.addEventListener("pointerdown", onPointerDown);
  elements.viewerStage.addEventListener("pointerup", onPointerUp);
  elements.viewerStage.addEventListener("pointercancel", () => {
    pointerId = null;
  });
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
