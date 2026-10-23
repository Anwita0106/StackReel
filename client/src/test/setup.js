import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => { cleanup(); localStorage.clear(); window.location.hash = ''; vi.restoreAllMocks(); });

if (!window.matchMedia) {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
class RO { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = window.ResizeObserver || RO;
window.DOMMatrixReadOnly = window.DOMMatrixReadOnly || class { constructor() { this.m22 = 1; } };
if (!HTMLCanvasElement.prototype.getContext || !process.env.CANVAS) {
  HTMLCanvasElement.prototype.getContext = () => null;
}
