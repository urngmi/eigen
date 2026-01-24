import * as pdfjsLib from 'pdfjs-dist';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

export class PDFRenderer {
  constructor(app) {
    this.app = app;
    this.documents = new Map();
    this.pageElements = new Map();
    this.viewer = document.getElementById('pdf-viewer');
    this.container = document.getElementById('pdf-container');
    
    this.setupScrollListener();
  }

  async loadDocument(data, tabId) {
    try {
      const loadingTask = pdfjsLib.getDocument({ data });
      const pdfDoc = await loadingTask.promise;
      
      this.documents.set(tabId, pdfDoc);
      this.pageElements.set(tabId, []);
      
      // Update page count immediately after document is loaded
      this.app.updateUI();
      
      await this.renderDocument(tabId);
      
      return pdfDoc;
    } catch (error) {
      console.error('Error loading PDF:', error);
      alert('Error loading PDF: ' + error.message);
      throw error;
    }
  }

  async renderDocument(tabId) {
    const doc = this.documents.get(tabId);
    if (!doc) return;

    const tab = this.app.tabManager.getTab(tabId);
    if (!tab) return;

    this.viewer.innerHTML = '';
    const pages = [];

    const numPages = tab.pageLayout === 'two-page' ? doc.numPages : doc.numPages;
    
    if (tab.pageLayout === 'two-page') {
      this.viewer.classList.add('two-page-layout');
    } else {
      this.viewer.classList.remove('two-page-layout');
    }

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const pageContainer = await this.createPageContainer(doc, pageNum, tabId);
      pages.push(pageContainer);
      this.viewer.appendChild(pageContainer);
    }

    this.pageElements.set(tabId, pages);
  }

  async createPageContainer(doc, pageNum, tabId) {
    const tab = this.app.tabManager.getTab(tabId);
    const page = await doc.getPage(pageNum);
    
    const scale = tab.zoom || 1.0;
    const rotation = tab.rotation || 0;
    
    // Use device pixel ratio for high-DPI displays (Retina, 4K, etc.)
    const dpr = window.devicePixelRatio || 1;
    
    const viewport = page.getViewport({ scale, rotation });

    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    pageContainer.dataset.page = pageNum;
    pageContainer.style.width = `${viewport.width}px`;
    pageContainer.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    
    // Set canvas internal size to account for device pixel ratio
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    // Set canvas display size (CSS)
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext('2d');
    // Use setTransform for sharp rendering
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;

    // Add text layer
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    try {
      const textContent = await page.getTextContent();
      // Use PDF.js text layer renderer (new API or fallback)
      if (pdfjsLib.renderTextLayer) {
        await pdfjsLib.renderTextLayer({
          textContent,
          container: textLayerDiv,
          viewport,
          textDivs: [],
          enhanceTextSelection: true
        });
      } else {
        // Fallback for older PDF.js
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport
        });
        await textLayer.render();
      }
    } catch (e) {
      console.error('Error rendering text layer:', e);
    }

    // Add annotation layer
    const annotationLayerDiv = document.createElement('div');
    annotationLayerDiv.className = 'annotation-layer';
    annotationLayerDiv.style.width = `${viewport.width}px`;
    annotationLayerDiv.style.height = `${viewport.height}px`;
    annotationLayerDiv.dataset.page = pageNum;
    annotationLayerDiv.dataset.tab = tabId;

    pageContainer.appendChild(canvas);
    pageContainer.appendChild(textLayerDiv);
    pageContainer.appendChild(annotationLayerDiv);

    return pageContainer;
  }

  switchToTab(tabId) {
    const doc = this.documents.get(tabId);
    if (!doc) {
      this.viewer.innerHTML = '<div class="empty-state"><p>No document loaded</p></div>';
      return;
    }

    this.renderDocument(tabId);
    
    const tab = this.app.tabManager.getTab(tabId);
    if (tab && tab.scrollPosition) {
      this.container.scrollTop = tab.scrollPosition;
    }
  }

  closeDocument(tabId) {
    const doc = this.documents.get(tabId);
    if (doc) {
      doc.destroy();
    }
    this.documents.delete(tabId);
    this.pageElements.delete(tabId);
  }

  getDocument(tabId) {
    return this.documents.get(tabId);
  }

  async setZoom(tabId, zoom) {
    const tab = this.app.tabManager.getTab(tabId);
    if (!tab) return;

    tab.zoom = zoom;
    await this.renderDocument(tabId);
  }

  async fitToWidth(tabId, containerWidth) {
    const doc = this.documents.get(tabId);
    if (!doc) return;

    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1.0 });
    
    const scale = containerWidth / viewport.width;
    
    this.app.tabManager.updateTab(tabId, { zoom: scale });
    await this.renderDocument(tabId);
  }

  async setRotation(tabId, rotation) {
    const tab = this.app.tabManager.getTab(tabId);
    if (!tab) return;

    const currentPage = tab.currentPage || 1;
    
    await this.renderDocument(tabId);
    
    // Restore the current page position after rotation
    await this.goToPage(tabId, currentPage);
  }

  async setPageLayout(tabId, layout) {
    await this.renderDocument(tabId);
  }

  async goToPage(tabId, pageNum) {
    const pages = this.pageElements.get(tabId);
    if (!pages || pageNum < 1 || pageNum > pages.length) return;

    const pageContainer = pages[pageNum - 1];
    if (pageContainer) {
      pageContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      
      this.app.tabManager.updateTab(tabId, { currentPage: pageNum });
      document.getElementById('page-number').value = pageNum;
      
      // Update sidebar
      this.app.sidebar.updateCurrentPage(tabId, pageNum);
    }
  }

  setupScrollListener() {
    let scrollTimeout;
    
    this.container.addEventListener('scroll', () => {
      const activeTab = this.app.tabManager.getActiveTab();
      if (!activeTab) return;

      // Save scroll position
      this.app.tabManager.updateTab(activeTab.id, { 
        scrollPosition: this.container.scrollTop 
      });

      // Debounce page detection
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        this.detectCurrentPage(activeTab.id);
      }, 100);
    });
  }

  detectCurrentPage(tabId) {
    const pages = this.pageElements.get(tabId);
    if (!pages) return;

    const containerRect = this.container.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;

    for (let i = 0; i < pages.length; i++) {
      const pageRect = pages[i].getBoundingClientRect();
      
      if (pageRect.top <= containerCenter && pageRect.bottom >= containerCenter) {
        const pageNum = i + 1;
        const tab = this.app.tabManager.getTab(tabId);
        
        if (tab && tab.currentPage !== pageNum) {
          this.app.tabManager.updateTab(tabId, { currentPage: pageNum });
          document.getElementById('page-number').value = pageNum;
          this.app.sidebar.updateCurrentPage(tabId, pageNum);
        }
        break;
      }
    }
  }

  async exportPDF(tabId) {
    // For now, just return the original data
    // In a real implementation, this would include annotations
    const tab = this.app.tabManager.getTab(tabId);
    if (!tab || !tab.fileData) return null;

    return Array.from(tab.fileData);
  }
}
