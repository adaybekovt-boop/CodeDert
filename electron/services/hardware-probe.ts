import si from 'systeminformation';

export type HardwareTier = 'extreme' | 'high' | 'medium' | 'low';

export interface HardwareInfo {
  cpu: {
    manufacturer: string;
    brand: string;
    cores: number;
    physicalCores: number;
  };
  ram: {
    totalGB: number;
    freeGB: number;
  };
  gpu: {
    vendor: string;
    model: string;
    vramGB: number;
  } | null;
  os: {
    platform: string;
    distro: string;
    arch: string;
  };
  tier: HardwareTier;
}

export async function probeHardware(): Promise<HardwareInfo> {
  const [cpu, mem, graphics, osInfo] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.graphics(),
    si.osInfo(),
  ]);

  // Pick best GPU (largest VRAM)
  const bestGpu = graphics.controllers
    .filter((g) => g.vram && g.vram > 0)
    .sort((a, b) => (b.vram || 0) - (a.vram || 0))[0];

  const ramGB = Math.round(mem.total / 1024 / 1024 / 1024);
  const freeRamGB = Math.round(mem.free / 1024 / 1024 / 1024);
  const vramGB = bestGpu ? Math.round((bestGpu.vram || 0) / 1024) : 0;

  // Tier logic — favors RAM and VRAM
  let tier: HardwareTier;
  if (ramGB >= 32 && vramGB >= 16) tier = 'extreme';
  else if (ramGB >= 16 && (vramGB >= 8 || ramGB >= 24)) tier = 'high';
  else if (ramGB >= 8) tier = 'medium';
  else tier = 'low';

  return {
    cpu: {
      manufacturer: cpu.manufacturer,
      brand: cpu.brand,
      cores: cpu.cores,
      physicalCores: cpu.physicalCores,
    },
    ram: {
      totalGB: ramGB,
      freeGB: freeRamGB,
    },
    gpu: bestGpu
      ? {
          vendor: bestGpu.vendor || 'unknown',
          model: bestGpu.model || 'unknown',
          vramGB,
        }
      : null,
    os: {
      platform: osInfo.platform,
      distro: osInfo.distro,
      arch: osInfo.arch,
    },
    tier,
  };
}
