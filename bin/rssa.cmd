@echo off
rem Runs the RSS-A CLI from a clone (no build step; needs Node 22.18+).
node --no-warnings "%~dp0..\packages\sdk-js\src\cli.ts" %*
