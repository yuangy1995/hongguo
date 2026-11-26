import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t, useLanguage } from '../i18n';
import { getSkin, subscribeSkin } from '../theme';
import { Play, Film, RefreshCw } from './icons';

export function useSkin() {
  return useSyncExternalStore(subscribeSkin, getSkin, () => 'default');
}

const WHEEL_DIGITS = Array.from({ length: 50 }, (_, index) => index % 10);

function RollingDigit({ digit, place, stepHint }) {
  const [slot, setSlot] = useState(20 + digit);
  const [snapping, setSnapping] = useState(false);
  const prevDigit = useRef(digit);

  useEffect(() => {
    if (digit === prevDigit.current && stepHint === 0) return;
    const currentMod = ((slot % 10) + 10) % 10;
    const direction = stepHint >= 0 ? 1 : -1;
    let delta = digit - currentMod;
    if (direction > 0 && delta < 0) delta += 10;
    if (direction < 0 && delta > 0) delta -= 10;
    if (place === 0 && Math.abs(stepHint) >= 5 && Math.abs(delta) < 6) {
      delta += direction * 10;
    }
    prevDigit.current = digit;
    setSnapping(false);
    setSlot(current => {
      const next = current + delta;
      if (next < 6 || next > 43) return 20 + digit;
      return next;
    });
  }, [digit, place, stepHint]);

  const handleTransitionEnd = () => {
    if (slot < 12 || slot > 37) {
      const normalized = 20 + (((slot % 10) + 10) % 10);
      setSnapping(true);
      setSlot(normalized);
    }
  };

  const duration = Math.min(700, 320 + place * 140);

  return (
    <span className="soft-digit-wheel" aria-hidden="true">
      <span
        className={`soft-digit-strip${snapping ? ' is-snapping' : ''}`}
        style={{
          transform: `translateY(${-slot * 1.24}em)`,
          transitionDuration: snapping ? '0ms' : `${duration}ms`,
        }}
        onTransitionEnd={handleTransitionEnd}
      >
        {WHEEL_DIGITS.map((num, index) => (
          <span className="soft-digit-cell" key={index}>{num}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * 机械数字：滚轮计数器，数值变化时每一位独立滚动，低位滚得更快，停止时带轻微过冲回弹。
 * 非新拟物皮肤下直接原样输出文本，保持既有界面与测试语义不变。
 */
export function RollingNumber({ value, suffix = '', className = '' }) {
  const skin = useSkin();
  const raw = `${value ?? ''}${suffix}`;
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : Number.parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  const prevNumeric = useRef(Number.isFinite(numeric) ? numeric : 0);
  const [stepHint, setStepHint] = useState(0);

  useEffect(() => {
    if (!Number.isFinite(numeric)) return;
    const diff = numeric - prevNumeric.current;
    if (diff !== 0) {
      prevNumeric.current = numeric;
      setStepHint(diff);
    }
  }, [numeric]);

  if (skin !== 'soft' || !/\d/.test(raw)) {
    return <>{raw}</>;
  }

  const chars = [...raw];
  const digitPositions = chars.reduce((acc, ch, idx) => {
    if (ch >= '0' && ch <= '9') acc.push(idx);
    return acc;
  }, []);

  return (
    <span className={`soft-odometer ${className}`.trim()} aria-label={raw}>
      {chars.map((ch, idx) => {
        if (ch < '0' || ch > '9') {
          return <span className="soft-odometer-symbol" aria-hidden="true" key={`s-${idx}`}>{ch}</span>;
        }
        const rank = digitPositions.indexOf(idx);
        const place = Math.max(0, digitPositions.length - 1 - rank);
        return (
          <RollingDigit
            key={`d-${place}`}
            digit={Number(ch)}
            place={place}
            stepHint={stepHint}
          />
        );
      })}
    </span>
  );
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  if (Math.abs(endAngle - startAngle) < 0.5) return '';
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/**
 * 旋钮调节：拖动旋转按刻度吸附，外圈亮起已选范围，数值和图表目标线实时联动。
 */
export function SoftKnob({
  value,
  options,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  ariaLabel,
  unit = '',
  recommendedRange,
  chartBars,
}) {
  useLanguage();
  const dialRef = useRef(null);
  const dragCleanupRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const stops = options
    ? options.map((opt, index) => ({
      value: opt.value,
      label: opt.label,
      numeric: opt.numeric ?? index + 1,
    }))
    : Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, index) => {
      const v = min + index * step;
      return { value: v, label: `${v}${unit}`, numeric: v };
    });

  const count = Math.max(2, stops.length);
  const activeIndex = Math.max(0, stops.findIndex(item => item.value === value));
  const current = stops[activeIndex] || stops[0];
  const ratio = activeIndex / (count - 1);
  const startDeg = -135;
  const endDeg = 135;
  const currentDeg = startDeg + ratio * (endDeg - startDeg);

  const commitIndex = nextIndex => {
    const clamped = Math.max(0, Math.min(count - 1, nextIndex));
    const target = stops[clamped];
    if (target && target.value !== value) {
      onChange?.(target.value);
    }
  };

  const updateFromPointer = (clientX, clientY, dragState) => {
    const rect = dialRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 10 && dragState) {
      const deltaSteps = Math.round((dragState.startY - clientY) / 16);
      commitIndex(dragState.startIndex + deltaSteps);
      return;
    }
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (deg > 180) deg -= 360;
    const clampedDeg = Math.max(startDeg, Math.min(endDeg, deg));
    const nextRatio = (clampedDeg - startDeg) / (endDeg - startDeg);
    commitIndex(Math.round(nextRatio * (count - 1)));
  };

  const handlePointerDown = event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const dragState = { startY: event.clientY, startIndex: activeIndex };
    setDragging(true);
    updateFromPointer(event.clientX, event.clientY, dragState);

    const onMove = moveEvent => updateFromPointer(moveEvent.clientX, moveEvent.clientY, dragState);
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };
    const onUp = upEvent => {
      target.releasePointerCapture?.(upEvent.pointerId);
      setDragging(false);
      detach();
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = detach;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleKeyDown = event => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      commitIndex(activeIndex + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      commitIndex(activeIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      commitIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      commitIndex(count - 1);
    }
  };

  const bars = chartBars || (count <= 12
    ? stops.map((stop, idx) => ({
      key: String(stop.value),
      ratio: (idx + 1) / count,
      stopIndex: idx,
      recommended: recommendedRange ? stop.numeric >= recommendedRange[0] && stop.numeric <= recommendedRange[1] : false,
    }))
    : Array.from({ length: 10 }, (_, idx) => {
      const stopIdx = Math.round((idx / 9) * (count - 1));
      return {
        key: String(idx),
        ratio: (idx + 1) / 10,
        stopIndex: stopIdx,
        recommended: false,
      };
    }));

  const tickMarks = count <= 16
    ? stops.map((_, idx) => idx)
    : Array.from({ length: 11 }, (_, idx) => Math.round((idx / 10) * (count - 1)));

  const targetBottom = 12 + ratio * 74;

  return (
    <div className={`soft-knob-panel${dragging ? ' is-dragging' : ''}`}>
      <div className="soft-knob-unit">
        <div
          ref={dialRef}
          className="soft-knob-dial-wrap"
          role="slider"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-valuemin={stops[0]?.numeric ?? 0}
          aria-valuemax={stops[count - 1]?.numeric ?? count}
          aria-valuenow={current?.numeric ?? 0}
          aria-valuetext={current?.label ? String(t(current.label)) : ''}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
        >
          <svg className="soft-knob-svg" viewBox="0 0 120 120" aria-hidden="true">
            <path
              className="soft-knob-track-arc"
              d={describeArc(60, 60, 48, startDeg, endDeg)}
              fill="none"
              strokeWidth="6"
              strokeLinecap="round"
            />
            {ratio > 0.005 && (
              <path
                className="soft-knob-active-arc"
                d={describeArc(60, 60, 48, startDeg, currentDeg)}
                fill="none"
                strokeWidth="6"
                strokeLinecap="round"
              />
            )}
            {tickMarks.map(stopIdx => {
              const tickRatio = stopIdx / (count - 1);
              const deg = startDeg + tickRatio * (endDeg - startDeg);
              const pt = polarToCartesian(60, 60, 56, deg);
              const lit = stopIdx <= activeIndex;
              return (
                <circle
                  key={stopIdx}
                  className={`soft-knob-tick${lit ? ' is-lit' : ''}`}
                  cx={pt.x}
                  cy={pt.y}
                  r={lit ? 2.3 : 1.7}
                />
              );
            })}
          </svg>
          <div className="soft-knob-cap" style={{ transform: `rotate(${currentDeg}deg)` }} aria-hidden="true">
            <span className="soft-knob-indicator" />
          </div>
        </div>
        <div className="soft-knob-readout">
          <strong className="soft-knob-value">
            <RollingNumber value={current.numeric} suffix={unit} />
          </strong>
          {options && <span className="soft-knob-sub">{t(current.label)}</span>}
        </div>
      </div>

      <div className="soft-knob-chart" aria-hidden="true">
        <div className="soft-knob-bars">
          {bars.map((bar, idx) => {
            const active = bar.stopIndex <= activeIndex;
            return (
              <span
                key={bar.key}
                className={`soft-knob-bar${active ? ' is-active' : ''}${bar.recommended ? ' is-recommended' : ''}`}
                style={{ height: `${Math.round(18 + bar.ratio * 68)}%` }}
                onClick={() => commitIndex(bar.stopIndex)}
              />
            );
          })}
        </div>
        <div className="soft-target-line" style={{ bottom: `${targetBottom}%` }}>
          <span className="soft-target-tag">
            {t("目标线")} <RollingNumber value={current.numeric} suffix={unit} />
          </span>
        </div>
        {recommendedRange && (
          <span className="soft-chart-caption">
            {t("建议范围")} {recommendedRange[0]}–{recommendedRange[1]}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 波动开关：模块右上角开关，拨上去指示灯亮、图表从灰色渐变为彩色，拨下来反向渐暗，滑块带吸附回弹。
 */
export function SoftVerticalSwitch({ checked, onChange, disabled = false, ariaLabel }) {
  const [dragOffset, setDragOffset] = useState(null);
  const movedRef = useRef(false);
  const dragCleanupRef = useRef(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const handlePointerDown = event => {
    if (disabled || (event.button !== undefined && event.button !== 0)) return;
    const target = event.currentTarget;
    const startY = event.clientY;
    const base = checked ? -18 : 0;
    movedRef.current = false;
    target.setPointerCapture?.(event.pointerId);

    const onMove = moveEvent => {
      const dy = moveEvent.clientY - startY;
      if (Math.abs(dy) > 3) movedRef.current = true;
      if (movedRef.current) {
        const clamped = Math.max(-18, Math.min(0, base + dy));
        setDragOffset(clamped);
      }
    };
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };
    const onUp = upEvent => {
      target.releasePointerCapture?.(upEvent.pointerId);
      detach();
      if (movedRef.current) {
        const dy = upEvent.clientY - startY;
        const finalPos = Math.max(-18, Math.min(0, base + dy));
        const nextChecked = finalPos <= -9;
        setDragOffset(null);
        if (nextChecked !== checked) onChange?.(nextChecked);
      } else {
        setDragOffset(null);
      }
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = detach;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const previewOn = dragOffset !== null ? dragOffset <= -9 : checked;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`soft-rocker${previewOn ? ' is-on' : ''}${dragOffset !== null ? ' is-dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onClick={() => {
        if (!disabled && !movedRef.current) onChange?.(!checked);
      }}
    >
      <span className="soft-rocker-led" aria-hidden="true" />
      <span className="soft-rocker-slot" aria-hidden="true">
        <span
          className="soft-rocker-thumb"
          style={dragOffset !== null ? { transform: `translateY(${dragOffset}px)`, transition: 'none' } : undefined}
        />
      </span>
    </button>
  );
}

/**
 * 模块微型趋势条：配合波动开关从灰色渐变为彩色，反向拨下时渐暗。
 */
export function SoftStatusBars({ active, values = [38, 64, 52, 84, 72, 92, 68] }) {
  const skin = useSkin();
  if (skin !== 'soft') return null;
  return (
    <div className={`soft-module-chart${active ? ' is-lit' : ''}`} aria-hidden="true">
      {values.map((v, idx) => (
        <span
          key={idx}
          className="soft-module-bar"
          data-tone={idx % 4}
          style={{ height: `${v}%` }}
        />
      ))}
    </div>
  );
}

/**
 * 为原生 checkbox（如设置页开关）在新拟物皮肤下补充上下拨动吸附与回弹手感，不改动原有 DOM 结构。
 */
export function useSoftCheckboxDrag(rootRef) {
  const skin = useSkin();
  useEffect(() => {
    if (skin !== 'soft') return undefined;
    const container = rootRef?.current || document;
    let activeCleanup = null;
    const onPointerDown = event => {
      const input = event.target instanceof HTMLInputElement
        && event.target.type === 'checkbox'
        && (event.target.closest('.proxy-switch-row') || event.target.closest('.builtin-source-row'))
        ? event.target
        : null;
      if (!input || input.disabled) return;
      const startY = event.clientY;
      const base = input.checked ? -16 : 0;
      let dragged = false;

      const onMove = moveEvent => {
        const dy = moveEvent.clientY - startY;
        if (Math.abs(dy) > 4) dragged = true;
        if (dragged) {
          const clamped = Math.max(-16, Math.min(0, base + dy));
          input.style.setProperty('--soft-thumb-y', `${clamped}px`);
          input.dataset.dragging = 'true';
        }
      };
      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        delete input.dataset.dragging;
        input.style.removeProperty('--soft-thumb-y');
        activeCleanup = null;
      };
      const onUp = upEvent => {
        detach();
        if (!dragged) return;
        const dy = upEvent.clientY - startY;
        const shouldCheck = Math.max(-16, Math.min(0, base + dy)) <= -8;
        const suppressClick = clickEvent => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        };
        input.addEventListener('click', suppressClick, { capture: true, once: true });
        if (shouldCheck !== input.checked) {
          input.click();
        }
      };
      activeCleanup?.();
      activeCleanup = detach;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    container.addEventListener('pointerdown', onPointerDown);
    return () => {
      activeCleanup?.();
      container.removeEventListener('pointerdown', onPointerDown);
    };
  }, [skin, rootRef]);
}

/**
 * 卡片抽拉：卡片堆叠展示，抽出顶部卡片时后方卡片依次下沉，拖动不足则弹回，超过阈值展开为详情。
 */
export function SoftCardStack({
  items = [],
  activeIndex = 0,
  onSelectIndex,
  onExpandItem,
  onPlayItem,
  resolving = false,
  ranking = false,
  sourceLabel = '',
  compact = false,
}) {
  useLanguage();
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [expanded, setExpanded] = useState(false);
  const dragCleanupRef = useRef(null);
  const current = items[activeIndex];

  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    setExpanded(false);
    setDrag({ x: 0, y: 0, active: false });
  }, [current?.series_id]);

  if (!current) return null;

  const rearItems = items.slice(activeIndex + 1, activeIndex + 4);
  const threshold = 68;
  const pullDistance = Math.hypot(drag.x, drag.y);
  const pullProgress = Math.min(1.25, pullDistance / threshold);
  const overThreshold = pullDistance >= threshold && items.length > 1;

  const handlePointerDown = event => {
    if (resolving) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest('button, a, select, input')) return;
    const target = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    target.setPointerCapture?.(event.pointerId);

    const onMove = moveEvent => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 5) moved = true;
      if (moved) {
        setDrag({ x: dx, y: dy, active: true });
      }
    };
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };
    const onUp = upEvent => {
      target.releasePointerCapture?.(upEvent.pointerId);
      detach();
      const dx = upEvent.clientX - startX;
      const dy = upEvent.clientY - startY;
      const dist = Math.hypot(dx, dy);
      setDrag({ x: 0, y: 0, active: false });
      if (!moved) {
        if (onExpandItem) onExpandItem(current);
        else setExpanded(prev => !prev);
      } else if (dist >= threshold && items.length > 1) {
        onSelectIndex?.((activeIndex + 1) % items.length);
      }
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = detach;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const intro = current.intro || current.series_intro || current.description || '';
  const sinkFactor = Math.min(1, pullProgress);

  return (
    <div className={`soft-stack-stage${expanded ? ' is-expanded' : ''}${compact ? ' is-compact' : ''}`}>
      <div className="soft-stack-deck">
        {[...rearItems].reverse().map((item, revIdx) => {
          const depth = rearItems.length - revIdx; // 1 = closest behind top card, 3 = deepest
          const baseOffset = depth * 9;
          const extraSink = sinkFactor * (depth * 8 + 4);
          const baseScale = 1 - depth * 0.032;
          const extraShrink = sinkFactor * (depth * 0.018);
          return (
            <div
              key={item.series_id}
              className={`soft-stack-rear${drag.active ? ' is-dragging' : ''}`}
              data-depth={depth}
              aria-hidden="true"
              style={{
                transform: `translate3d(0, ${(baseOffset + extraSink).toFixed(1)}px, 0) scale(${(baseScale - extraShrink).toFixed(3)})`,
                opacity: Math.max(0.55, 0.96 - depth * 0.12 - sinkFactor * 0.10),
                zIndex: 10 - depth,
              }}
            />
          );
        })}

        <article
          className={`soft-stack-top${drag.active ? ' is-dragging' : ''}${overThreshold ? ' is-ready' : ''}`}
          style={drag.active ? {
            transform: `translate3d(${(drag.x * 0.82).toFixed(1)}px, ${(drag.y * 0.76).toFixed(1)}px, 0) rotate(${(drag.x * 0.03).toFixed(2)}deg) scale(${(1 + sinkFactor * 0.015).toFixed(3)})`,
            zIndex: 20,
          } : { zIndex: 20 }}
          onPointerDown={handlePointerDown}
        >
          <div className="soft-stack-grip" aria-hidden="true">
            <span className="soft-stack-grip-bar" />
            <span className="soft-stack-grip-hint">
              {t(!drag.active ? '拖动切换下一部 · 点击查看详情' : overThreshold ? '松手切换下一部' : '继续拖动切换下一部')}
            </span>
          </div>

          <div className="soft-stack-body">
            <div className="drama-poster soft-stack-poster">
              {current.cover ? (
                <img src={current.cover} alt={t(`${current.series_title}海报`)} />
              ) : (
                <div className="drama-poster-fallback"><Film size={32} /><span>{t("暂无海报")}</span></div>
              )}
            </div>
            <div className="soft-stack-copy">
              <div className="soft-stack-badges">
                <span className="drama-feed-rank">
                  {t(ranking && current.rank > 0 ? `榜单第 ${current.rank} 名` : `本次片单第 ${activeIndex + 1} 部`)}
                </span>
                {current.episode_count > 0 && (
                  <span className="soft-stack-ep">
                    <RollingNumber value={current.episode_count} /> {t("集")}
                  </span>
                )}
                {current.heat && <span className="soft-stack-heat">{t(current.heat)}</span>}
              </div>

              <h3>{current.series_title}</h3>

              {(current.tags?.length > 0 || sourceLabel) && (
                <p className="drama-feed-tags">
                  {(current.tags?.length ? current.tags : [sourceLabel]).filter(Boolean).join(' · ')}
                </p>
              )}

              {expanded && intro.trim() && (
                <p className="soft-stack-detail-intro">{intro}</p>
              )}

              <div className="soft-stack-actions">
                {onPlayItem && (
                  <button type="button" className="btn btn-primary" disabled={resolving} onClick={() => onPlayItem(current)}>
                    <Play size={15} />
                    {t(resolving ? '正在打开播放器…' : '在播放器播放')}
                  </button>
                )}
                {onExpandItem && (
                  <button type="button" className="btn btn-outline" onClick={() => onExpandItem(current)}>
                    {t("详情与下载")}
                  </button>
                )}
                {!onExpandItem && expanded && (
                  <button type="button" className="btn btn-outline" onClick={() => setExpanded(false)}>
                    {t("收起详情")}
                  </button>
                )}
                {onSelectIndex && items.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={resolving}
                    onClick={() => onSelectIndex((activeIndex + 1) % items.length)}
                  >
                    <RefreshCw size={14} />
                    {t("换下一部")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
