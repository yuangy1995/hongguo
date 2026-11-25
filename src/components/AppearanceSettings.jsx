import { t, useLanguage } from '../i18n';
import LanguageSettings from './LanguageSettings';
import React, { useEffect, useRef, useState } from 'react';
import { getThemePreference, setThemePreference, getPosterSize, setPosterSize, getSkin, setSkin } from '../theme';
import { APP_ICONS, getAppIcon, getAppIconOption, setLocalAppIcon, subscribeAppIcon } from '../appIcons';
import { RollingNumber, SoftKnob, useSkin } from './SoftControls';

const POSTER_KNOB_OPTIONS = [
  { value: 'small', label: '小', numeric: 80 },
  { value: 'standard', label: '标准', numeric: 100 },
  { value: 'large', label: '大', numeric: 130 },
  { value: 'extra-large', label: '特大', numeric: 160 },
];

export default function AppearanceSettings({ active = true, showZoom = true }) {
  useLanguage();
  const activeSkin = useSkin();
  const [preference, setPreference] = useState(getThemePreference);
  const [skin, setSkinPreference] = useState(getSkin);
  const [appIcon, setAppIconState] = useState(getAppIcon);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconMenuOpen, setIconMenuOpen] = useState(false);
  const iconDropdownRef = useRef(null);
  const [posterSize, setPosterPreference] = useState(getPosterSize);
  const [zoom, setZoom] = useState(null);
  const [zoomBusy, setZoomBusy] = useState(false);
  const zoomPending = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let changed = false;
    const unsubscribe = window.electronAPI.onInterfaceZoomChanged?.(value => {
      changed = true;
      if (!cancelled) setZoom(value);
    });
    const unsubIcon = subscribeAppIcon(value => {
      if (!cancelled) setAppIconState(value);
    });
    window.electronAPI.getSettings().then(settings => {
      if (!cancelled && !changed) setZoom(settings.ui_zoom ?? 1);
      if (!cancelled && settings?.app_icon) {
        setLocalAppIcon(settings.app_icon);
        setAppIconState(settings.app_icon);
      }
    }).catch(() => {
      if (!cancelled) setError('界面大小读取失败，请重新进入设置。');
    });
    return () => { cancelled = true; unsubscribe?.(); unsubIcon(); };
  }, [active]);

  const changeZoom = async direction => {
    if (zoomPending.current) return;
    zoomPending.current = true;
    setZoomBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.changeWindowZoom(direction);
      if (!result?.success) throw new Error(result?.error || '界面大小保存失败，请重试。');
      setZoom(result.zoom);
    } catch (error) {
      setError(error.message || '界面大小保存失败，请重试。');
    } finally {
      zoomPending.current = false;
      setZoomBusy(false);
    }
  };

  const applyPosterSize = value => {
    try {
      setPosterSize(value);
      setPosterPreference(value);
      setError('');
    } catch {
      setError('海报大小保存失败，请重试。');
    }
  };

  const changePosterSize = event => applyPosterSize(event.target.value);

  const changeTheme = (event) => {
    try {
      setThemePreference(event.target.value);
      setPreference(event.target.value);
      setError('');
    } catch {
      setError('外观保存失败，请重试。');
    }
  };

  const changeSkin = event => {
    try {
      setSkin(event.target.value);
      setSkinPreference(event.target.value);
      setError('');
    } catch {
      setError('皮肤保存失败，请重试。');
    }
  };

  useEffect(() => {
    if (!iconMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (iconDropdownRef.current && !iconDropdownRef.current.contains(event.target)) {
        setIconMenuOpen(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setIconMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [iconMenuOpen]);

  const changeAppIcon = async (iconId) => {
    setIconMenuOpen(false);
    if (iconBusy || iconId === appIcon) return;
    setIconBusy(true);
    setError('');
    try {
      const normalized = setLocalAppIcon(iconId);
      setAppIconState(normalized);
      if (window.electronAPI?.setAppIcon) {
        const result = await window.electronAPI.setAppIcon(normalized);
        if (!result?.success) throw new Error(result?.error || '应用图标切换失败，请重试。');
      }
    } catch (err) {
      setError(err?.message || '应用图标切换失败，请重试。');
    } finally {
      setIconBusy(false);
    }
  };

  const currentIconOption = getAppIconOption(appIcon);

  return (
    <>
    <LanguageSettings />
    <div className="settings-group">
      <label className="settings-label" htmlFor="appearance-theme">{t("外观")}</label>
      <select id="appearance-theme" className="input-field select-field" value={preference} onChange={changeTheme} aria-describedby="appearance-hint">
        <option value="system">{t("跟随系统")}</option>
        <option value="light">{t("浅色")}</option>
        <option value="dark">{t("深色")}</option>
      </select>
      <p className="settings-hint" id="appearance-hint">{t("立即生效并自动保存。跟随系统时，外观会随系统切换。")}</p>
    </div>
    {showZoom && <div className="settings-group">
      <label className="settings-label" htmlFor="appearance-skin">{t("皮肤")}</label>
      <select id="appearance-skin" className="input-field select-field" value={skin} onChange={changeSkin} aria-describedby="appearance-skin-hint">
        <option value="default">{t("默认")}</option>
        <option value="frosted">{t("磨砂玻璃")}</option>
        <option value="soft">{t("新拟物")}</option>
      </select>
      <p className="settings-hint" id="appearance-skin-hint">{t("立即生效并自动保存，浅色和深色外观都适用。")}</p>
    </div>}
    {showZoom && <div className="settings-group">
      <span className="settings-label" id="appearance-icon-label">{t("应用图标")}</span>
      <div className="app-icon-dropdown" ref={iconDropdownRef}>
        <button
          type="button"
          className={`input-field select-field app-icon-trigger ${iconMenuOpen ? 'is-open' : ''}`}
          aria-labelledby="appearance-icon-label"
          aria-describedby="appearance-icon-hint"
          aria-haspopup="listbox"
          aria-expanded={iconMenuOpen}
          disabled={iconBusy}
          onClick={() => setIconMenuOpen(open => !open)}
        >
          <span className="app-icon-trigger-value">
            <img className="app-icon-thumb" src={currentIconOption.src} alt="" draggable="false" />
            <span className="app-icon-trigger-text">{t(currentIconOption.name)}</span>
          </span>
          <svg className="app-icon-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {iconMenuOpen && (
          <div className="app-icon-popover" role="listbox" aria-labelledby="appearance-icon-label">
            {APP_ICONS.map(item => {
              const selected = appIcon === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={iconBusy}
                  className={`app-icon-option ${selected ? 'is-selected' : ''}`}
                  onClick={() => changeAppIcon(item.id)}
                >
                  <img className="app-icon-option-img" src={item.src} alt="" draggable="false" />
                  <span className="app-icon-option-meta">
                    <span className="app-icon-option-name">{t(item.name)}</span>
                    <span className="app-icon-option-style">{t(item.style)}</span>
                  </span>
                  {selected && <span className="app-icon-option-check" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className="settings-hint" id="appearance-icon-hint">{t("点击即可切换应用左上角和系统程序坞／任务栏图标，立即生效并自动保存。")}</p>
    </div>}
    {showZoom && <div className="settings-group">
      <span className="settings-label" id="appearance-zoom-label">{t("界面与字号")}</span>
      <div className="appearance-zoom" role="group" aria-labelledby="appearance-zoom-label" aria-describedby="appearance-zoom-hint">
        <button type="button" className="btn btn-outline" aria-label={t("缩小界面与字号")} disabled={zoomBusy || zoom === null || zoom <= 0.5} onClick={() => changeZoom('out')}>{t("缩小")}</button>
        <output aria-live="polite">{zoom === null ? t('读取中…') : <RollingNumber value={Math.round(zoom * 100)} suffix="%" />}</output>
        <button type="button" className="btn btn-outline" aria-label={t("放大界面与字号")} disabled={zoomBusy || zoom === null || zoom >= 2} onClick={() => changeZoom('in')}>{t("放大")}</button>
        <button type="button" className="btn btn-outline" disabled={zoomBusy || zoom === null || zoom === 1} onClick={() => changeZoom('reset')}>{t("恢复 100%")}</button>
      </div>
      <p className="settings-hint" id="appearance-zoom-hint">{t("默认 100%，不会按屏幕分辨率自动放大。需要时可手动调整文字和按钮大小（50%–200%），立即生效并记住你的选择。")}</p>
    </div>}
    <div className="settings-group">
      <label className="settings-label" htmlFor="appearance-poster-size">{t("海报大小")}</label>
      {activeSkin === 'soft' ? (
        <SoftKnob
          value={posterSize}
          options={POSTER_KNOB_OPTIONS}
          unit="%"
          ariaLabel={t("海报大小")}
          onChange={applyPosterSize}
        />
      ) : (
        <select id="appearance-poster-size" className="input-field select-field" value={posterSize} onChange={changePosterSize} aria-describedby="appearance-poster-hint">
          <option value="small">{t("小")}</option>
          <option value="standard">{t("标准")}</option>
          <option value="large">{t("大")}</option>
          <option value="extra-large">{t("特大")}</option>
        </select>
      )}
      <p className="settings-hint" id="appearance-poster-hint">{t("发现页海报随窗口宽度自动排列；调大后每行显示更少。保持原有比例，立即生效并自动保存。")}</p>
      {error && <p className="appearance-error" role="alert">{t(error)}</p>}
    </div>
    </>
  );
}
