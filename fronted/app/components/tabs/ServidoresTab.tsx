'use client';

import ServerFleet from '../assets/ServerFleet';

// Parque de servidores: ficha tecnica de cada servidor con su imagen.
export default function ServidoresTab({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Parque de servidores</h2>
        <p className="text-sm text-slate-500">
          Marca, modelo y especificaciones de cada servidor: lo detecta el agente y se completa a mano (ubicación, garantía, proveedor...).
        </p>
      </div>
      <ServerFleet isAdmin={isAdmin} />
    </div>
  );
}
