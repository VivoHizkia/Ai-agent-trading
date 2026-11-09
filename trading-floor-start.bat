@echo off
REM Dijalankan otomatis saat login Windows (taruh shortcut-nya di folder Startup).
REM Menghidupkan lagi bot, notifier, dan dashboard dari daftar yang terakhir disimpan dengan "pm2 save".
cd /d "%~dp0"
call pm2 resurrect
