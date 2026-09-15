/** Rasterises the shared compass SVG with resvg, using the bundled brand font (no browser needed). */
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { COLORS, FONT_FAMILY } from '@shared/brand';
import { COMPASS_WIDTH, renderCompassSvg, renderSnapshotCardSvg, SNAPSHOT_WIDTH, type SnapshotCardInput } from '@shared/compass';
import { config } from '../config';

const FONT_FILES = [400, 500, 600, 700, 800].map((weight) =>
  path.join(config.assetsDir, 'fonts', `PlusJakartaSans-${weight}.ttf`),
);

let sunMark: string | null = null;

function sunMarkDataUri(): string {
  sunMark ??= `data:image/png;base64,${fs.readFileSync(path.join(config.assetsDir, 'brand', 'shichida-sun.png')).toString('base64')}`;
  return sunMark;
}

function rasterise(svg: string, pixelWidth: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: pixelWidth },
    background: COLORS.surface,
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return resvg.render().asPng();
}

/** The chart alone at 3× for print-quality embedding in the PDF. */
export function renderChartPng(parts: Parameters<typeof renderCompassSvg>[0]): Buffer {
  return rasterise(renderCompassSvg(parts), COMPASS_WIDTH * 3);
}

/** The shareable snapshot card at 2× (1200 px wide). */
export function renderSnapshotPng(input: Omit<SnapshotCardInput, 'logoDataUri'>): Buffer {
  return rasterise(renderSnapshotCardSvg({ ...input, logoDataUri: sunMarkDataUri() }), SNAPSHOT_WIDTH * 2);
}
