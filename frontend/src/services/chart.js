/**
 * D3.js Chart Service for Station 7-day Price History
 */

import * as d3 from 'd3';
import { FUEL_TYPES } from './data.js';

export function renderStationPriceChart(containerElement, station, fuelId) {
  if (!containerElement) return;

  // Clear previous contents
  containerElement.innerHTML = '';

  const fuelConfig = FUEL_TYPES[fuelId] || FUEL_TYPES.gasoline_95;
  const key = fuelConfig.key;

  if (!station || !station.data || station.data.length === 0) {
    containerElement.innerHTML = `
      <div class="flex items-center justify-center h-48 text-slate-400 text-sm">
        No hay datos históricos disponibles para esta estación.
      </div>`;
    return;
  }

  // Filter entries that have prices for this fuel
  const parseDate = d3.timeParse('%Y-%m-%d');
  const validData = station.data
    .map(d => ({
      date: parseDate(d.date) || new Date(d.date),
      dateStr: d.date,
      price: d[key],
    }))
    .filter(d => typeof d.price === 'number')
    .sort((a, b) => a.date - b.date);

  if (validData.length === 0) {
    containerElement.innerHTML = `
      <div class="flex items-center justify-center h-48 text-slate-400 text-sm">
        Sin precio registrado de ${fuelConfig.label} en esta estación.
      </div>`;
    return;
  }

  // Single data point case
  if (validData.length === 1) {
    const d = validData[0];
    containerElement.innerHTML = `
      <div class="flex flex-col items-center justify-center h-48 bg-slate-50 rounded-xl p-4 border border-slate-100 text-center">
        <span class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Precio actual registrado</span>
        <span class="text-3xl font-extrabold text-slate-900 mb-1">${d.price.toFixed(3)} €/L</span>
        <span class="text-xs text-slate-500 mb-3">Fecha: ${d.dateStr}</span>
        <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-medium">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Historial rodante de 7 días se irá enriqueciendo automáticamente
        </div>
      </div>`;
    return;
  }

  // Dimensions
  const margin = { top: 20, right: 30, bottom: 35, left: 55 };
  const width = 480 - margin.left - margin.right;
  const height = 210 - margin.top - margin.bottom;

  // Create SVG
  const svg = d3
    .select(containerElement)
    .append('svg')
    .attr('viewBox', `0 0 480 210`)
    .attr('class', 'w-full h-auto overflow-visible')
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // X & Y Scales
  const x = d3
    .scaleTime()
    .domain(d3.extent(validData, d => d.date))
    .range([0, width]);

  const prices = validData.map(d => d.price);
  const minP = d3.min(prices);
  const maxP = d3.max(prices);
  const padding = (maxP - minP) * 0.25 || 0.02;

  const y = d3
    .scaleLinear()
    .domain([minP - padding, maxP + padding])
    .range([height, 0]);

  // Gradient Definition
  const defs = svg.append('defs');
  const gradient = defs
    .append('linearGradient')
    .attr('id', 'price-gradient')
    .attr('x1', '0%')
    .attr('y1', '0%')
    .attr('x2', '0%')
    .attr('y2', '100%');

  gradient
    .append('stop')
    .attr('offset', '0%')
    .attr('stop-color', fuelConfig.color)
    .attr('stop-opacity', 0.35);

  gradient
    .append('stop')
    .attr('offset', '100%')
    .attr('stop-color', fuelConfig.color)
    .attr('stop-opacity', 0.0);

  // Horizontal Grid Lines
  svg
    .append('g')
    .attr('class', 'grid')
    .call(
      d3
        .axisLeft(y)
        .ticks(4)
        .tickSize(-width)
        .tickFormat('')
    )
    .call(g => g.select('.domain').remove())
    .call(g => g.selectAll('.tick line').attr('stroke', '#e2e8f0').attr('stroke-dasharray', '2,2'));

  // X Axis
  const xAxis = d3
    .axisBottom(x)
    .ticks(Math.min(validData.length, 5))
    .tickFormat(d3.timeFormat('%d/%m'));

  svg
    .append('g')
    .attr('transform', `translate(0,${height})`)
    .call(xAxis)
    .call(g => g.select('.domain').attr('stroke', '#cbd5e1'))
    .call(g => g.selectAll('.tick text').attr('fill', '#64748b').attr('font-size', '11px').attr('dy', '9px'))
    .call(g => g.selectAll('.tick line').attr('stroke', '#cbd5e1'));

  // Y Axis
  const yAxis = d3
    .axisLeft(y)
    .ticks(4)
    .tickFormat(d => `${d.toFixed(3)} €`);

  svg
    .append('g')
    .call(yAxis)
    .call(g => g.select('.domain').remove())
    .call(g => g.selectAll('.tick text').attr('fill', '#64748b').attr('font-size', '11px'))
    .call(g => g.selectAll('.tick line').remove());

  // Area Generator
  const area = d3
    .area()
    .x(d => x(d.date))
    .y0(height)
    .y1(d => y(d.price))
    .curve(d3.curveMonotoneX);

  svg
    .append('path')
    .datum(validData)
    .attr('fill', 'url(#price-gradient)')
    .attr('d', area);

  // Line Generator
  const line = d3
    .line()
    .x(d => x(d.date))
    .y(d => y(d.price))
    .curve(d3.curveMonotoneX);

  svg
    .append('path')
    .datum(validData)
    .attr('fill', 'none')
    .attr('stroke', fuelConfig.color)
    .attr('stroke-width', 2.5)
    .attr('stroke-linejoin', 'round')
    .attr('stroke-linecap', 'round')
    .attr('d', line);

  // Interactive points & tooltips
  const tooltipGroup = svg.append('g').style('display', 'none');
  const tooltipBg = tooltipGroup
    .append('rect')
    .attr('fill', '#1e293b')
    .attr('rx', 6)
    .attr('ry', 6)
    .attr('width', 90)
    .attr('height', 34)
    .attr('opacity', 0.95);

  const tooltipText = tooltipGroup
    .append('text')
    .attr('fill', '#ffffff')
    .attr('font-size', '11px')
    .attr('text-anchor', 'middle')
    .attr('x', 45)
    .attr('y', 15)
    .attr('font-weight', 'bold');

  const tooltipSubtext = tooltipGroup
    .append('text')
    .attr('fill', '#94a3b8')
    .attr('font-size', '9px')
    .attr('text-anchor', 'middle')
    .attr('x', 45)
    .attr('y', 28);

  svg
    .selectAll('.dot')
    .data(validData)
    .enter()
    .append('circle')
    .attr('cx', d => x(d.date))
    .attr('cy', d => y(d.price))
    .attr('r', 4.5)
    .attr('fill', '#ffffff')
    .attr('stroke', fuelConfig.color)
    .attr('stroke-width', 2.5)
    .style('cursor', 'pointer')
    .on('mouseenter', function (event, d) {
      d3.select(this).transition().duration(150).attr('r', 6.5);
      tooltipGroup.style('display', null);

      let tooltipX = x(d.date) - 45;
      if (tooltipX < 0) tooltipX = 0;
      if (tooltipX > width - 90) tooltipX = width - 90;

      let tooltipY = y(d.price) - 42;
      if (tooltipY < 0) tooltipY = y(d.price) + 12;

      tooltipGroup.attr('transform', `translate(${tooltipX}, ${tooltipY})`);
      tooltipText.text(`${d.price.toFixed(3)} €/L`);
      tooltipSubtext.text(d.dateStr);
    })
    .on('mouseleave', function () {
      d3.select(this).transition().duration(150).attr('r', 4.5);
      tooltipGroup.style('display', 'none');
    });
}
