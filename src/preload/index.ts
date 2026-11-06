// The renderer's only way to the back end: one call, by name.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('traceDesktop', {
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke('api', method, args),
});
