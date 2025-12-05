#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <linux/if.h>
#include <linux/if_tun.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <stdint.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <time.h>
#include <netinet/ip.h>
#include <netinet/ip6.h>
#include <netinet/tcp.h>
#include <netinet/udp.h>

int tuntap_connect(const char *iface_name, short flags, char *iface_name_out) {
    int tuntap_fd;
    struct ifreq ifr;

    printf("[tun-proxy] Criando interface TUN...\n");
    fflush(stdout);

    tuntap_fd = open("/dev/net/tun", O_RDWR | O_CLOEXEC);
    if (tuntap_fd == -1) {
        perror("[tun-proxy] Erro ao abrir /dev/net/tun");
        return -1;
    }

    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_flags = flags;
    if (iface_name != NULL) {
        strncpy(ifr.ifr_name, iface_name, IFNAMSIZ - 1);
    }

    if (ioctl(tuntap_fd, TUNSETIFF, (void *)&ifr) == -1) {
        perror("[tun-proxy] ioctl(TUNSETIFF) falhou");
        close(tuntap_fd);
        return -1;
    }

    if (iface_name_out) {
        strncpy(iface_name_out, ifr.ifr_name, IFNAMSIZ);
    }

    printf("[tun-proxy] Interface criada: %s\n", ifr.ifr_name);
    fflush(stdout);
    return tuntap_fd;
}

int netlink_set_addr_ipv6(int netlink_fd, const char *iface_name, const char *address, uint8_t network_prefix_bits) {
    char buf[512];
    struct nlmsghdr *nlh = (struct nlmsghdr *) buf;
    struct ifaddrmsg *ifa;
    struct rtattr *rta;
    struct in6_addr in6;
    struct sockaddr_nl kaddr;
    unsigned int ifindex;

    printf("[tun-proxy] Configurando IPv6 %s/%u...\n", address, network_prefix_bits);
    fflush(stdout);

    ifindex = if_nametoindex(iface_name);
    if (ifindex == 0) {
        fprintf(stderr, "[tun-proxy] if_nametoindex(%s) falhou\n", iface_name);
        return -1;
    }

    if (inet_pton(AF_INET6, address, &in6) != 1) {
        fprintf(stderr, "[tun-proxy] inet_pton IPv6 inválido: %s\n", address);
        return -1;
    }

    memset(buf, 0, sizeof(buf));

    nlh->nlmsg_len = NLMSG_LENGTH(sizeof(struct ifaddrmsg));
    nlh->nlmsg_flags = NLM_F_REQUEST | NLM_F_CREATE | NLM_F_EXCL;
    nlh->nlmsg_type = RTM_NEWADDR;
    nlh->nlmsg_seq = 1;
    nlh->nlmsg_pid = 0;

    ifa = (struct ifaddrmsg *) NLMSG_DATA(nlh);
    ifa->ifa_family = AF_INET6;
    ifa->ifa_prefixlen = network_prefix_bits;
    ifa->ifa_flags = 0;
    ifa->ifa_scope = 0;
    ifa->ifa_index = ifindex;

    /* IFA_ADDRESS */
    rta = (struct rtattr *) ((char *) nlh + NLMSG_ALIGN(nlh->nlmsg_len));
    rta->rta_type = IFA_ADDRESS;
    rta->rta_len = RTA_LENGTH(sizeof(in6));
    memcpy(RTA_DATA(rta), &in6, sizeof(in6));
    nlh->nlmsg_len = NLMSG_ALIGN(nlh->nlmsg_len) + RTA_LENGTH(sizeof(in6));

    /* IFA_LOCAL (some stacks expect) */
    rta = (struct rtattr *) ((char *) nlh + NLMSG_ALIGN(nlh->nlmsg_len));
    rta->rta_type = IFA_LOCAL;
    rta->rta_len = RTA_LENGTH(sizeof(in6));
    memcpy(RTA_DATA(rta), &in6, sizeof(in6));
    nlh->nlmsg_len = NLMSG_ALIGN(nlh->nlmsg_len) + RTA_LENGTH(sizeof(in6));

    memset(&kaddr, 0, sizeof(kaddr));
    kaddr.nl_family = AF_NETLINK;
    kaddr.nl_pid = 0; /* kernel */
    kaddr.nl_groups = 0;

    if (sendto(netlink_fd, nlh, nlh->nlmsg_len, 0, (struct sockaddr *)&kaddr, sizeof(kaddr)) == -1) {
        perror("[tun-proxy] sendto(RTM_NEWADDR) falhou");
        return -1;
    }

    printf("[tun-proxy] Endereço IPv6 configurado!\n");
    fflush(stdout);
    return 0;
}

int netlink_connect() {
    int netlink_fd;
    struct sockaddr_nl addr;

    printf("[tun-proxy] Criando socket NETLINK...\n");
    fflush(stdout);

    netlink_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
    if (netlink_fd == -1) {
        perror("[tun-proxy] socket(AF_NETLINK) falhou");
        return -1;
    }

    memset(&addr, 0, sizeof(addr));
    addr.nl_family = AF_NETLINK;

    if (bind(netlink_fd, (struct sockaddr *)&addr, sizeof(addr)) == -1) {
        perror("[tun-proxy] bind(netlink) falhou");
        close(netlink_fd);
        return -1;
    }

    printf("[tun-proxy] NETLINK criado.\n");
    fflush(stdout);
    return netlink_fd;
}

int netlink_link_up(int netlink_fd, const char *iface_name) {
    struct {
        struct nlmsghdr header;
        struct ifinfomsg content;
    } request;

    printf("[tun-proxy] Ativando interface...\n");
    fflush(stdout);

    memset(&request, 0, sizeof(request));
    request.header.nlmsg_len = NLMSG_LENGTH(sizeof(request.content));
    request.header.nlmsg_flags = NLM_F_REQUEST;
    request.header.nlmsg_type = RTM_NEWLINK;
    request.content.ifi_index = if_nametoindex(iface_name);
    request.content.ifi_flags = IFF_UP;
    request.content.ifi_change = 0xffffffff;

    if (send(netlink_fd, &request, request.header.nlmsg_len, 0) == -1) {
        perror("[tun-proxy] send(RTM_NEWLINK) falhou");
        return -1;
    }

    printf("[tun-proxy] Interface ativada!\n");
    fflush(stdout);
    return 0;
}

int create_udp_sender_ipv6(uint16_t port) {
    int fd;
    struct sockaddr_in6 addr;

    fd = socket(AF_INET6, SOCK_DGRAM, 0);
    if (fd == -1) return -1;

    memset(&addr, 0, sizeof(addr));
    addr.sin6_family = AF_INET6;
    addr.sin6_port = htons(port);
    if (inet_pton(AF_INET6, "::1", &addr.sin6_addr) != 1) {
        close(fd);
        errno = EINVAL;
        return -1;
    }

    if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) == -1) {
        int e = errno;
        close(fd);
        errno = e;
        return -1;
    }
    return fd;
}

int create_udp_receiver_ipv6(uint16_t port) {
    int fd;
    struct sockaddr_in6 addr;

    fd = socket(AF_INET6, SOCK_DGRAM, 0);
    if (fd == -1) return -1;

    memset(&addr, 0, sizeof(addr));
    addr.sin6_family = AF_INET6;
    addr.sin6_port = htons(port);
    if (inet_pton(AF_INET6, "::1", &addr.sin6_addr) != 1) {
        close(fd);
        errno = EINVAL;
        return -1;
    }

    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) == -1) {
        int e = errno;
        close(fd);
        errno = e;
        return -1;
    }
    return fd;
}


void log_packet_meta(const unsigned char *packet, ssize_t size) {
    if (size < 1) return;

    char src[64] = "unknown";
    char dst[64] = "unknown";
    char proto[16] = "OTHER";

    if ((packet[0] >> 4) == 4) {
        struct iphdr *ip4 = (struct iphdr *)packet;

        inet_ntop(AF_INET, &ip4->saddr, src, sizeof(src));
        inet_ntop(AF_INET, &ip4->daddr, dst, sizeof(dst));

        switch (ip4->protocol) {
            case IPPROTO_TCP: strcpy(proto, "TCP"); break;
            case IPPROTO_UDP: strcpy(proto, "UDP"); break;
            case IPPROTO_ICMP: strcpy(proto, "ICMP"); break;
            default: strcpy(proto, "OTHER");
        }

    } else if ((packet[0] >> 4) == 6) {
        // IPv6
        struct ip6_hdr *ip6 = (struct ip6_hdr *)packet;

        inet_ntop(AF_INET6, &ip6->ip6_src, src, sizeof(src));
        inet_ntop(AF_INET6, &ip6->ip6_dst, dst, sizeof(dst));

        switch (ip6->ip6_nxt) {
            case IPPROTO_TCP: strcpy(proto, "TCP"); break;
            case IPPROTO_UDP: strcpy(proto, "UDP"); break;
            case IPPROTO_ICMPV6: strcpy(proto, "ICMPv6"); break;
            default: strcpy(proto, "OTHER");
        }
    }

    printf("[tun-proxy] packet-meta { \"src\": \"%s\", \"dst\": \"%s\", \"proto\": \"%s\", \"size\": %ld }\n",
           src, dst, proto, (long)size);

    fflush(stdout);
}

int run_proxy(int tuntap_fd, int send_fd, int recv_fd) {
    struct pollfd poll_fds[2];
    char buf[65536];

    printf("[tun-proxy] Iniciando loop do proxy UDP <-> TUN...\n");
    fflush(stdout);

    poll_fds[0].fd = tuntap_fd;
    poll_fds[0].events = POLLIN;
    poll_fds[1].fd = recv_fd;
    poll_fds[1].events = POLLIN;

    while (1) {
        int rc = poll(poll_fds, 2, -1);
        if (rc == -1) {
            perror("[tun-proxy] poll() falhou");
            return -1;
        }

        if (poll_fds[0].revents & POLLIN) {
            ssize_t n = read(tuntap_fd, buf, sizeof(buf));
            if (n < 0) {
                perror("[tun-proxy] erro lendo da TUN");
                return -1;
            }
            printf("[tun-proxy] → Packet da TUN (%ld bytes)\n", (long)n);
            fflush(stdout);

            //enviar metadados
            log_packet_meta((unsigned char*)buf, n);

            ssize_t s = send(send_fd, buf, n, 0);
            (void)s;
        }

        if (poll_fds[1].revents & POLLIN) {
            ssize_t n = recv(recv_fd, buf, sizeof(buf), 0);
            if (n < 0) {
                perror("[tun-proxy] erro lendo do UDP");
                return -1;
            }
            printf("[tun-proxy] ← Packet from UDP (%ld bytes)\n", (long)n);
            fflush(stdout);

            log_packet_meta((unsigned char*)buf, n);

            ssize_t w = write(tuntap_fd, buf, n);
            (void)w;
        }
    }
    return 0;
}

/* parse address/prefix */
int split_address(char *address_str, uint8_t *network_prefix_bits) {
    char *sep = strchr(address_str, '/');
    if (!sep) {
        *network_prefix_bits = 128;
    } else {
        *sep = '\0';
        char *p = sep + 1;
        char *end;
        long v = strtol(p, &end, 10);
        if (*end != '\0' || v < 0 || v > 128) {
            *sep = '/';
            return -1;
        }
        *network_prefix_bits = (uint8_t)v;
    }
    struct in6_addr tmp;
    if (inet_pton(AF_INET6, address_str, &tmp) != 1) return -1;
    return 0;
}

int parse_port(char *s, uint16_t *out) {
    char *end;
    long v = strtol(s, &end, 10);
    if (*end != '\0' || v < 0 || v > 65535) return -1;
    *out = (uint16_t)v;
    return 0;
}

int main(int argc, char **argv) {
    printf("[tun-proxy] ----------------------------------\n");
    printf("[tun-proxy] Iniciando tun-proxy (IPv6)...\n");
    printf("[tun-proxy] ----------------------------------\n");
    fflush(stdout);

    if (argc < 4) {
        fprintf(stderr, "Usage: %s <ipv6/prefix> <send-port> <recv-port>\n", argv[0]);
        return 1;
    }

    char *address = argv[1];
    uint8_t prefix_bits;
    if (split_address(address, &prefix_bits) == -1) {
        fprintf(stderr, "[tun-proxy] IPv6 inválido: %s\n", address);
        return 1;
    }

    uint16_t send_port, recv_port;
    if (parse_port(argv[2], &send_port) == -1) return 1;
    if (parse_port(argv[3], &recv_port) == -1) return 1;

    /* UDP sockets */
    printf("[tun-proxy] Bind UDP local (porta %u)...\n", send_port);
    fflush(stdout);
    int send_fd = create_udp_sender_ipv6(send_port);
    if (send_fd == -1) { perror("[tun-proxy] Erro ao criar send socket"); return 1; }

    printf("[tun-proxy] Bind UDP recv (porta %u)...\n", recv_port);
    fflush(stdout);
    int recv_fd = create_udp_receiver_ipv6(recv_port);
    if (recv_fd == -1) { perror("[tun-proxy] Erro ao criar recv socket"); return 1; }

    char ifname[IFNAMSIZ] = {0};
    int tuntap_fd = tuntap_connect(NULL, IFF_TUN | IFF_NO_PI, ifname);
    if (tuntap_fd == -1) { fprintf(stderr, "[tun-proxy] tuntap_connect falhou: %s\n", strerror(errno)); return 1; }

    int netlink_fd = netlink_connect();
    if (netlink_fd == -1) { fprintf(stderr, "[tun-proxy] netlink_connect falhou: %s\n", strerror(errno)); return 1; }

    if (netlink_set_addr_ipv6(netlink_fd, ifname, address, prefix_bits) == -1) { fprintf(stderr, "[tun-proxy] Erro configurando IPv6\n"); close(netlink_fd); return 1; }

    if (netlink_link_up(netlink_fd, ifname) == -1) { fprintf(stderr, "[tun-proxy] Erro ao ativar interface\n"); close(netlink_fd); return 1; }

    close(netlink_fd);

    printf("[tun-proxy] Inicialização concluída. Entrando no loop principal...\n");
    fflush(stdout);

    if (run_proxy(tuntap_fd, send_fd, recv_fd) == -1) {
        fprintf(stderr, "[tun-proxy] run_proxy falhou: %s\n", strerror(errno));
        return 1;
    }

    return 0;
}
