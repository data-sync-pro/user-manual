import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  inject,
} from '@angular/core';
import { PipelineEntry } from '../core/models';
import { formatArrShort } from '../core/format';

// Inline horizontal-bar SVG of pipeline ARR by stage. Built imperatively into
// the host element (ported from portal.js renderPipelineChart) so the markup +
// classes match the original exactly.
@Component({
  selector: 'app-pipeline-chart',
  standalone: true,
  template: '',
})
export class PipelineChartComponent implements OnChanges {
  @Input() data: PipelineEntry[] = [];

  private host = inject(ElementRef<HTMLElement>);

  ngOnChanges(): void {
    this.render(this.host.nativeElement as HTMLElement, this.data);
  }

  private render(el: HTMLElement, data: PipelineEntry[]): void {
    el.textContent = '';
    const SVGNS = 'http://www.w3.org/2000/svg';

    if (!Array.isArray(data) || data.length === 0) {
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', '0 0 600 80');
      svg.setAttribute('role', 'img');
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'pc-empty');
      t.setAttribute('x', '300');
      t.setAttribute('y', '44');
      t.setAttribute('text-anchor', 'middle');
      t.textContent = 'No pipeline data yet.';
      svg.appendChild(t);
      el.appendChild(svg);
      return;
    }

    // Geometry (user-space units; viewBox scales to container).
    const W = 600;
    const rowH = 46;
    const gap = 14;
    const labelW = 132; // left gutter for stage labels
    const valueW = 96; // right gutter for value labels
    const padTop = 12;
    const padBottom = 26; // room for axis ticks
    const barAreaW = W - labelW - valueW;
    const H = padTop + data.length * rowH + (data.length - 1) * gap + padBottom;
    const maxArr = Math.max(...data.map((d) => Number(d.arr) || 0)) || 1;

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-labelledby', 'pc-title');

    const title = document.createElementNS(SVGNS, 'title');
    title.setAttribute('id', 'pc-title');
    const totalArr = data.reduce((s, d) => s + (Number(d.arr) || 0), 0);
    title.textContent =
      'Pipeline ARR by sales stage. Total ' +
      formatArrShort(totalArr) +
      ' across ' +
      data.map((d) => d.stage + ' ' + formatArrShort(d.arr)).join(', ') +
      '.';
    svg.appendChild(title);

    // Axis gridlines + tick labels (0, 50%, 100% of max).
    const ticks = [0, 0.5, 1];
    ticks.forEach((frac) => {
      const x = labelW + barAreaW * frac;
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('class', 'pc-gridline');
      line.setAttribute('x1', String(x));
      line.setAttribute('x2', String(x));
      line.setAttribute('y1', String(padTop));
      line.setAttribute('y2', String(H - padBottom));
      svg.appendChild(line);

      const tick = document.createElementNS(SVGNS, 'text');
      tick.setAttribute('class', 'pc-axis');
      tick.setAttribute('x', String(x));
      tick.setAttribute('y', String(H - padBottom + 16));
      tick.setAttribute('text-anchor', frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle');
      tick.textContent = formatArrShort(maxArr * frac);
      svg.appendChild(tick);
    });

    data.forEach((d, i) => {
      const arr = Number(d.arr) || 0;
      const y = padTop + i * (rowH + gap);
      const barY = y + rowH / 2 - 9;
      const barH = 18;
      const w = Math.max(2, (arr / maxArr) * barAreaW);

      // Track (full width, subtle).
      const track = document.createElementNS(SVGNS, 'rect');
      track.setAttribute('class', 'pc-bar-track');
      track.setAttribute('x', String(labelW));
      track.setAttribute('y', String(barY));
      track.setAttribute('width', String(barAreaW));
      track.setAttribute('height', String(barH));
      track.setAttribute('rx', '3');
      svg.appendChild(track);

      // Bar.
      const bar = document.createElementNS(SVGNS, 'rect');
      bar.setAttribute('class', 'pc-bar');
      bar.setAttribute('x', String(labelW));
      bar.setAttribute('y', String(barY));
      bar.setAttribute('width', String(w));
      bar.setAttribute('height', String(barH));
      bar.setAttribute('rx', '3');
      svg.appendChild(bar);

      // Stage label (left).
      const sl = document.createElementNS(SVGNS, 'text');
      sl.setAttribute('class', 'pc-stage-label');
      sl.setAttribute('x', '0');
      sl.setAttribute('y', String(barY + barH / 2 + 4));
      sl.textContent = d.stage;
      svg.appendChild(sl);

      // Count label (under stage label).
      if (d.count != null) {
        const cl = document.createElementNS(SVGNS, 'text');
        cl.setAttribute('class', 'pc-count-label');
        cl.setAttribute('x', '0');
        cl.setAttribute('y', String(barY + barH / 2 + 19));
        cl.textContent = d.count + (d.count === 1 ? ' deal' : ' deals');
        svg.appendChild(cl);
      }

      // Value label (right gutter).
      const vl = document.createElementNS(SVGNS, 'text');
      vl.setAttribute('class', 'pc-value-label');
      vl.setAttribute('x', String(W));
      vl.setAttribute('y', String(barY + barH / 2 + 4));
      vl.setAttribute('text-anchor', 'end');
      vl.textContent = formatArrShort(arr);
      svg.appendChild(vl);
    });

    el.appendChild(svg);
  }
}
