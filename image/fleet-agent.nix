# NixOS system for one ephemeral agent container.
#
# The provisioner instantiates this as a systemd-nspawn container with an ephemeral rootfs
# (`containers.<name>.ephemeral = true`), so nothing here needs to persist across boots.
# The orchestrator injects the capability config + scoped credentials read-only at
# /etc/fleet/opencode, and drives the headless server over HTTP. See docs/architecture.md,
# docs/orchestrator.md, and ADR 0001.
{ pkgs, ... }:
{
  system.stateVersion = "25.11";

  # It is a container, not a bootable machine: no bootloader, no root fs.
  boot.isContainer = true;

  # Disposable worker: keep the closure lean and skip docs/desktop.
  documentation.enable = false;
  environment.systemPackages = [ pkgs.opencode pkgs.git ];

  # The one long-lived process: a headless opencode server the orchestrator talks to.
  systemd.services.opencode-serve = {
    description = "opencode headless server";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.opencode}/bin/opencode serve --hostname=0.0.0.0 --port=4096";
      Restart = "on-failure";
      RestartSec = 1;
      Environment = [
        "OPENCODE_DISABLE_AUTOUPDATE=1"
        "OPENCODE_DISABLE_PRUNE=1"
        # Capability config + agents live here, mounted read-only at provision time.
        "OPENCODE_CONFIG_DIR=/etc/fleet/opencode"
      ];
    };
  };

  # The orchestrator reaches :4096 over the container veth; nothing else listens.
  networking.firewall.allowedTCPPorts = [ 4096 ];
}
