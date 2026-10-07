# NixOS system for one disposable agent container.
#
# The provisioner instantiates this with `nixos-container` (create/start/destroy) per task
# attempt, so nothing here needs to persist across boots. See ADR 0001 and ADR 0012.
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

  # nixos-container copies the host's /etc/resolv.conf (127.0.0.53, the host's resolved
  # stub), which is unreachable from the container. Run resolved inside the container so
  # that stub answers, forwarding to public upstreams.
  services.resolved.enable = true;
  networking.nameservers = [ "1.1.1.1" "8.8.8.8" ];

  # Agents push over HTTPS with a token injected at runtime as GITHUB_TOKEN; the helper reads
  # it from the environment, so the token is never baked into the image or the config.
  environment.etc."gitconfig".text = ''
    [credential "https://github.com"]
      helper = "!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f"
  '';

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
      # Scoped credentials + provider keys, baked at provision time (mode 0400).
      EnvironmentFile = [ "-/etc/fleet/opencode/credentials.env" ];
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
