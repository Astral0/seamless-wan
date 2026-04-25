# Fix Ethernet priority when connected to RPi (OpenMPTCProuter)
# Run as Administrator before plugging in the RPi via RJ45.
# This prevents Windows from routing Internet traffic through the RPi
# instead of the Wi-Fi connection.

Set-NetIPInterface -InterfaceAlias "Ethernet" -InterfaceMetric 9999
Write-Host "Ethernet metric set to 9999 — Wi-Fi will stay priority for Internet." -ForegroundColor Green
