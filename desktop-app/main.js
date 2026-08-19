const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 950,
        height: 780,
        title: "StreamShare Desktop",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    // Escuta pedido do Renderer para listar as janelas e telas disponíveis
    ipcMain.handle('get-sources', async () => {
        try {
            const sources = await desktopCapturer.getSources({ 
                types: ['window', 'screen'],
                thumbnailSize: { width: 0, height: 0 } // Desativa thumbnails para ficar leve e rápido
            });
            return sources.map(source => ({
                id: source.id,
                name: source.name
            }));
        } catch (error) {
            console.error("Erro ao obter fontes de captura:", error);
            return [];
        }
    });

    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
