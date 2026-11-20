import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
export default function CastPanel({ seriesId, episode, title, videoRef }) {
  useLanguage();
  const [open,setOpen]=useState(false), [devices,setDevices]=useState([]), [busy,setBusy]=useState(false), [error,setError]=useState(''), [target,setTarget]=useState('');
  const rootRef = useRef(null);
  const operation = useRef(null);
  useEffect(() => {
    if (!open || typeof document === 'undefined' || !document.addEventListener) return undefined;
    const onPointerDown = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const cancel = () => {
    const pending = operation.current;
    if (!pending) return;
    pending.cancelled = true;
    if (pending.requestId) void window.electronAPI.releaseOnlinePlay({ requestId: pending.requestId }).catch(() => {});
    if (pending.connecting) void window.electronAPI.controlCasting('Stop').catch(() => {});
    if (pending.scanning) { operation.current = null; setBusy(false); }
  };
  useEffect(() => () => { if (operation.current?.requestId) cancel(); }, [seriesId, episode?.vid]);
  useEffect(() => () => { cancel(); void window.electronAPI.controlCasting('Stop').catch(() => {}); }, []);
  const run = async action => {
    if (operation.current) return;
    const pending = { cancelled: false };
    operation.current = pending;
    setBusy(true); setError('');
    try { await action(pending); }
    catch (e) { if (!pending.cancelled) setError(e.message); }
    finally { if (operation.current === pending) { operation.current = null; setBusy(false); } }
  };
  const check=result=>{if(!result?.success)throw new Error(result?.error || '投屏失败');return result;};
  const syncStatus=result=>{if(typeof result?.active==='boolean')setTarget(result.active ? result.name || '' : '');};
  const scan=()=>run(async pending=>{ pending.scanning = true; const result = check(await window.electronAPI.discoverCastDevices()); if (!pending.cancelled) setDevices(result.devices); });
  const start=id=>run(async pending=>{
    if (!episode || episode.locked) return;
    pending.requestId = crypto.randomUUID();
    let prepared;
    try {
      if (!episode.fileUrl) prepared=check(await window.electronAPI.prepareOnlinePlay({seriesId,vid:episode.vid,vidIndex:episode.vid_index,requestId:pending.requestId,prefetch:true}));
      if (pending.cancelled) return;
      pending.connecting = true;
      const result=await window.electronAPI.startCasting({deviceId:id,source:episode.fileUrl || prepared.url,title:`${title} 第${episode.vid_index}集`});
      syncStatus(result);check(result);
      if (pending.cancelled) { const stopped=await window.electronAPI.controlCasting('Stop');syncStatus(stopped);return; }
      videoRef.current?.pause();
    } finally {if(prepared?.streamId)await window.electronAPI.releaseOnlinePlay({streamId:prepared.streamId}).catch(() => {});}
  });
  const control=action=>run(async()=>{const result=await window.electronAPI.controlCasting(action);syncStatus(result);check(result);});
  return <div className="cast-panel" ref={rootRef}>
    <button type="button" className="btn btn-outline btn-sm cast-trigger" aria-expanded={open} aria-pressed={open} disabled={!episode || episode.locked} onClick={()=>{setOpen(!open);if(!open)scan();}}>{t("投屏")}{t(target ? ` · ${target}` : '')}</button>
    {open && <section className="cast-popover" role="dialog" aria-label={t("电视投屏")}>
      <div className="cast-popover-head">
        <strong>{t("电视投屏")}</strong>
        <button type="button" className="btn btn-outline btn-sm" onClick={()=>setOpen(false)}>{t("关闭")}</button>
      </div>
      <p className="cast-popover-hint">{t("电脑与电视连接同一局域网，电视需开启 DLNA。投屏前会缓存本集；格式支持取决于电视。")}</p>
      <div className="cast-popover-actions">
        <button type="button" className="btn btn-primary btn-sm cast-scan-btn" disabled={busy} onClick={scan}>{t(busy?'正在处理…':'重新搜索电视')}</button>
        {busy && <button type="button" className="btn btn-outline btn-sm" onClick={cancel}>{t("取消本次操作")}</button>}
      </div>
      {!busy && !devices.length && <p className="cast-popover-empty">{t("未发现电视，请检查电视的投屏设置和电脑防火墙。")}</p>}
      {!!devices.length && <div className="cast-popover-devices-wrap">
        <span className="cast-popover-label">{t("选择投屏设备")}</span>
        <div className="cast-popover-devices">
          {devices.map(device=><button type="button" className="btn btn-outline btn-sm cast-device-btn" disabled={busy} key={device.id} onClick={()=>start(device.id)}>{device.name}</button>)}
        </div>
      </div>}
      {target && <div className="cast-popover-controls" role="group" aria-label={t("投屏控制")}>{[['Play','播放'],['Pause','暂停'],['Stop','停止']].map(([action,label])=><button type="button" className="btn btn-outline btn-sm" key={action} disabled={busy} onClick={()=>control(action)}>{t(label)}</button>)}</div>}
      {error && <p className="cast-popover-error" role="alert">{t(error)}</p>}
    </section>}
  </div>;
}
