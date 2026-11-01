import { NextResponse } from 'next/server';
import redis from '@/lib/redis';

export const dynamic = 'force-dynamic';

/**
 * Health probe used by the portal frontend to decide whether this queue
 * deployment is reachable (primary self-hosted route vs. Vercel fallback).
 * Always answers 200 when the service itself is up; `redis` reflects the
 * downstream dependency so callers can distinguish.
 */
export async function GET() {
  let redisOk = false;
  try {
    redisOk = (await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ])) === 'PONG';
  } catch {
    redisOk = false;
  }

  return NextResponse.json(
    {
      status: 'ok',
      service: 'face-search-queue',
      redis: redisOk ? 'up' : 'down',
      timestamp: Date.now(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
