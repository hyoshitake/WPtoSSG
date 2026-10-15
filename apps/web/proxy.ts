import { NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const match = request.nextUrl.pathname.match(/^\/sites\/([^/]+)(\/.*)?$/);
  if (!match?.[1].includes('.')) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = `/api/public-sites/${match[1]}${match[2] ?? '/'}`;
  return NextResponse.rewrite(url);
}
export const config = { matcher: '/sites/:path*' };
