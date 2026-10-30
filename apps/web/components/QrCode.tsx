'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// QR-код ссылки (рисуется в браузере, ссылка никуда не отправляется)
export function QrCode({ value, size = 180, label }: { value: string; size?: number; label: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((u) => alive && setSrc(u))
      .catch(() => alive && setSrc(''));
    return () => {
      alive = false;
    };
  }, [value, size]);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={size} height={size} alt={label} style={{ borderRadius: 8, background: '#fff' }} />;
}
