import { NextResponse } from 'next/server';

interface BitsoTicker {
  success: boolean;
  payload: {
    last: string;
    bid:  string;
    ask:  string;
    high: string;
    low:  string;
  };
}

export async function GET() {
  try {
    const res = await fetch(
      'https://api.bitso.com/v3/ticker/?book=usdc_mxn',
      { next: { revalidate: 30 } },   // Cache 30 seconds on the server
    );

    if (!res.ok) throw new Error(`Bitso ${res.status}`);

    const json: BitsoTicker = await res.json();

    if (!json.success) throw new Error('Bitso API returned success=false');

    return NextResponse.json({
      rate:      parseFloat(json.payload.last),
      bid:       parseFloat(json.payload.bid),
      ask:       parseFloat(json.payload.ask),
      updatedAt: new Date().toISOString(),
      fallback:  false,
    });
  } catch (err) {
    // Fallback rate — keeps the UI functional if Bitso is unavailable
    return NextResponse.json({
      rate:      17.50,
      updatedAt: new Date().toISOString(),
      fallback:  true,
    });
  }
}
