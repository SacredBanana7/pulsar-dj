@echo off
title Pulsar DJ
cd /d "%~dp0"
start "" "http://localhost:5180"
node server.mjs
