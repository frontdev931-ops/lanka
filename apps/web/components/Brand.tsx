// The service's logo and name
export const BRAND_NAME = 'LANKA';

export function Brand() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-logo" src="/logo.png" alt="" width={34} height={34} />
      {BRAND_NAME}
    </>
  );
}
