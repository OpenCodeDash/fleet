# Dedicated host for the ephemeral agent fleet.
#
# It does nothing but run disposable systemd-nspawn agent containers and expose the few
# things the (off-box) orchestrator needs to reach them. The control plane — token
# minting, the board, the egress proxy's policy — lives elsewhere; see docs/architecture.md.
#
# `nix build .#fleet-host-vm` runs this host in QEMU for local development.
{ pkgs, fleetContainer, fleetEgressProxy, ... }:
{
  system.stateVersion = "25.11";
  networking.hostName = "fleet-host";

  # Flakes + the new `nix` CLI on the host.
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  # Machine-specific disk layout. Regenerate on the target with
  # `nixos-generate-config --root /mnt` and replace host/hardware-configuration.nix
  # (or swap this for a disko config). See docs/setup.md.
  imports = [ ./hardware-configuration.nix ];

  # UEFI boot. For a BIOS machine, replace with grub:
  #   boot.loader.grub.enable = true;
  #   boot.loader.grub.devices = [ "/dev/sdX" ];
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  # The agents: each is a systemd-nspawn container, started/stopped by the orchestrator.
  boot.enableContainers = true;

  # Containers are created with `nixos-container`, which gives each a private veth to this
  # host (10.233.x.0/24); the host is the gateway, so container egress passes through the
  # host's proxy and the host can reach each container's opencode server. See ADR 0012.
  networking.useNetworkd = true;
  networking.firewall.enable = true;
  # The off-box orchestrator connects over SSH; 3129 is the egress admin port.
  networking.firewall.allowedTCPPorts = [ 22 3129 ];

  # Containers may reach only the egress proxy on the host. There is deliberately no NAT, so
  # the proxy is the sole path off the container network (ADR 0008); anything not on a
  # container's registered allowlist is denied.
  networking.firewall.extraInputRules = ''
    ip saddr 10.233.0.0/16 tcp dport 3128 accept
  '';

  # Uplink DHCP — the nspawn zone only serves the containers themselves, so the host's own
  # NIC needs an address to reach the board, git and the Nix cache. `en*`/`eth*` covers
  # Proxmox/typical NIC names; the zone bridge (vz-*) and container veths (vb-*) are not matched.
  systemd.network.networks."10-uplink" = {
    matchConfig.Name = [ "en*" "eth*" ];
    networkConfig.DHCP = "yes";
  };

  # Keep the agent container system in the host store, so provisioning needs no build on
  # the host at container-start time.
  system.extraDependencies = [ fleetContainer ];

  # The off-box orchestrator drives this host over SSH (its CommandRunner).
  services.openssh.enable = true;
  environment.systemPackages = [ pkgs.git ];

  # Host-side default-deny egress proxy. Containers route through it; the orchestrator
  # registers each container's allowlist (its veth address) via the admin port at provision.
  # Base allowlist is empty — everything not explicitly registered is denied.
  systemd.services.fleet-egress = {
    description = "fleet egress proxy";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStart = "${fleetEgressProxy}/bin/fleet-egress-proxy";
      Restart = "on-failure";
    };
    environment = {
      FLEET_EGRESS_PORT = "3128";
      FLEET_EGRESS_ADMIN_PORT = "3129";
      FLEET_EGRESS_ALLOW = "";
    };
  };
}
